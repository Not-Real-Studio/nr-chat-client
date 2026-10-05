/**
 * createClient — тонкий клиент чата поверх {@link createHttpBackend}: то, что
 * нужно странице, чтобы поговорить с бэкендом nrchat (виджет `<nr-chat>`,
 * артефакт, редактор), без знания всей поверхности `ProtocolBackend`.
 *
 * ```ts
 * const chat = createClient('http://127.0.0.1:7800', { auth: 'ключ' })
 * const s = await chat.sessions.create()
 * const end = await chat.run(s.id, 'привет', { onEvent: (ev) => console.log(ev) })
 * ```
 *
 * Ран — `fetch` + чтение потока SSE (не `EventSource`: нужен POST с телом и
 * заголовок ключа). `signal` рана — отмена на сервере (`cancel`) и ожидание
 * `run_end` со статусом `cancelled`; полная поверхность протокола — `backend`.
 */

import type {
  AnyRunEvent,
  Capabilities,
  HistoryPage,
  ModelInfo,
  ParticipantRef,
  Part,
  ProfileInfo,
  ProtocolBackend,
  RunEndEvent,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionMetaDoc,
  SessionMetaPatch,
} from '@notrealstudio/nr-ui-protocol'
import { createHttpBackend, type HttpBackendOpts } from './http-backend.js'

export interface ClientOpts {
  /** Ключ доступа (`Authorization: Bearer`), если бэкенд его требует (`$auth_key`). */
  auth?: string
  /** Свой fetch (тесты, прокси). */
  fetch?: typeof globalThis.fetch
  /** Дополнительные заголовки транспорта. */
  headers?: HttpBackendOpts['headers']
  /** TTL кэша capabilities, мс. Default — навсегда. */
  capabilitiesTtl?: number
}

/** Вход рана: текст, части user-сообщения или `RunStartInput` целиком. */
export type RunInput = string | Part[] | RunStartInput

export interface RunOpts {
  /** Адресат хода (v1.19): `{kind: 'char', personaId}` / `{kind: 'user'}` (impersonate). */
  target?: ParticipantRef
  /** Каждое событие рана, по порядку (включая `run_end`). */
  onEvent?: (event: AnyRunEvent) => void
  /** Отмена: `cancel` на сервере; `run` всё равно резолвится `run_end` (`cancelled`). */
  signal?: AbortSignal
}

export interface ChatClient {
  /** Полная поверхность протокола (правки, свайпы, вложения, файлы…). */
  readonly backend: ProtocolBackend
  readonly baseUrl: string
  capabilities(): Promise<Capabilities>
  sessions: {
    list(): Promise<SessionInfo[]>
    create(opts?: SessionCreateOpts): Promise<SessionInfo>
    get(id: string): Promise<SessionInfo>
    history(id: string): Promise<HistoryPage>
    meta: {
      get(id: string): Promise<SessionMetaDoc>
      patch(id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc>
    }
  }
  /**
   * Ран целиком: события — в `onEvent`, результат — `run_end`. Отказ до
   * стрима (not_supported, busy, 401) — reject; ошибка рана — `run_end` со
   * статусом `error` (не reject).
   */
  run(sessionId: string, input: RunInput, opts?: RunOpts): Promise<RunEndEvent>
  /** Тот же ран итератором (для `for await`); отмена — `signal` или `cancel`. */
  stream(sessionId: string, input: RunInput, opts?: Omit<RunOpts, 'onEvent'>): AsyncIterable<AnyRunEvent>
  /** Ответ на `ask` (апрув, вопрос, тул сессии). */
  respond(sessionId: string, askId: string, answer: unknown): Promise<void>
  cancel(sessionId: string, runId: string): Promise<void>
  profiles(): Promise<ProfileInfo[]>
  models(): Promise<ModelInfo[]>
  close(): Promise<void>
}

/** Вход рана → `RunStartInput`. */
export function toRunInput(input: RunInput, target?: ParticipantRef): RunStartInput {
  const base: RunStartInput = typeof input === 'string' ? { userMessage: input } : Array.isArray(input) ? { userMessage: input } : { ...input }
  if (target) base.target = target
  return base
}

export function createClient(baseUrl: string, opts: ClientOpts = {}): ChatClient {
  const backend = createHttpBackend(baseUrl, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.capabilitiesTtl !== undefined ? { capabilitiesTtl: opts.capabilitiesTtl } : {}),
  })
  return clientOf(backend, baseUrl)
}

/**
 * Тот же клиент поверх любого `ProtocolBackend` (DEV-226): бэкенд в процессе
 * страницы (`backend-nr/browser` `createLocalBackend`, виджет `backend="local"`)
 * или свой транспорт. `baseUrl` — только метка (`local`).
 */
export function clientOf(backend: ProtocolBackend, baseUrl = 'local'): ChatClient {

  async function* stream(sid: string, input: RunInput, o: Omit<RunOpts, 'onEvent'> = {}): AsyncGenerator<AnyRunEvent> {
    const signal = o.signal
    let runId: string | undefined
    let cancelSent = false
    const cancel = (): void => {
      if (cancelSent || !runId) return
      cancelSent = true
      void backend.cancel(sid, runId).catch(() => {})
    }
    const onAbort = (): void => cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')
      for await (const ev of backend.run(sid, toRunInput(input, o.target))) {
        if (ev.type === 'run_start') {
          runId = (ev as { runId: string }).runId
          if (signal?.aborted) cancel()
        }
        yield ev
        if (ev.type === 'run_end') return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    backend,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    capabilities: () => backend.capabilities(),
    sessions: {
      list: () => backend.sessions.list(),
      create: (o) => backend.sessions.create(o),
      get: (id) => backend.sessions.get(id),
      history: (id) => backend.history(id),
      meta: {
        get: (id) => backend.meta!.get(id),
        patch: (id, patch) => backend.meta!.patch(id, patch),
      },
    },
    async run(sid, input, o = {}) {
      let end: RunEndEvent | undefined
      for await (const ev of stream(sid, input, o)) {
        o.onEvent?.(ev)
        if (ev.type === 'run_end') end = ev as RunEndEvent
      }
      if (!end) throw new Error('run: стрим кончился без run_end')
      return end
    },
    stream,
    respond: (sid, askId, answer) => backend.respond!(sid, askId, answer),
    cancel: (sid, runId) => backend.cancel(sid, runId),
    profiles: () => backend.profiles!.list(),
    models: () => backend.models!.list(),
    close: async () => {
      await backend.close?.()
    },
  }
}
