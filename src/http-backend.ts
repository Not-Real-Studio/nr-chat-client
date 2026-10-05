/**
 * createHttpBackend — клиентская сторона шва: HTTP + SSE → ProtocolBackend.
 * Переехал из backend-http (DEV-225): backend-http реэкспортирует отсюда.
 *
 * Тот же интерфейс, что у бэкенда за проводом: UI не различает локальный он
 * или удалённый (backends-spec §1). Поверх fetch — работает и в браузере, и в
 * node; EventSource не используется (ран стартует POST'ом с телом).
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md §9,
 *        nr-ui-protocol.dev/specs/backends-spec.md §3.2
 */

import type {
  AnyRunEvent,
  AssetData,
  FileContent,
  FileEntry,
  FileReadOpts,
  FileWriteOpts,
  WorkspaceUpdateEvent,
  WorkspaceUpdateListener,
  AttachmentContent,
  AttachmentPutResult,
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  HistoryPage,
  Message,
  MessageAppendOpts,
  MessageEditPatch,
  Part,
  ModelInfo,
  Persona,
  PersonasDoc,
  ProfileDoc,
  ProfileInfo,
  PromptView,
  ProtocolBackend,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionModel,
  ServiceEvent,
  SwipeTo,
  WorkspaceInfo,
} from '@notrealstudio/nr-ui-protocol'
import {
  BackendError,
  CODE_CONNECTION_LOST,
  CODE_NOT_SUPPORTED,
  NotSupportedError,
  errorMessage,
  parseSSEStream,
  parseServiceFrame,
  parseWorkspaceEvent,
  serviceErrorEvent,
  type WireEnvelope,
} from './wire.js'

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

export interface HttpBackendOpts {
  /** Своя реализация fetch (тесты, node-прокси, авторизующая обёртка). */
  fetch?: typeof globalThis.fetch
  /** Заголовки транспорта (auth — вне протокола, §10.6). Могут быть ленивыми. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** TTL кэша capabilities, мс. Default — навсегда, до close(). */
  capabilitiesTtl?: number
  /**
   * Ключ доступа бэкенда (`$auth_key` стенда, DEV-225): `Authorization: Bearer
   * <auth>` на каждом запросе, включая SSE. Явный `authorization` в `headers` —
   * главнее.
   */
  auth?: string
}


// ────────────────────────────────────────────────────────────────────────────
// createHttpBackend
// ────────────────────────────────────────────────────────────────────────────

/**
 * ProtocolBackend поверх HTTP-биндинга §9.
 *
 * ```ts
 * const backend = createHttpBackend('http://127.0.0.1:7331')
 * for await (const ev of backend.run(sid, { userMessage: 'привет' })) ...
 * ```
 *
 * Опциональные методы (fork, messages.*, catalog, ...) присутствуют всегда:
 * capabilities асинхронны, а фабрика синхронна — узнать их к моменту сборки
 * объекта нельзя. Правило «метод есть ⇔ capability заявлена» держит бэкенд за
 * проводом: незаявленная операция приезжает NotSupportedError. UI и так гасит
 * фичи по capabilities() (§1.2), а не по наличию метода.
 */
export function createHttpBackend(url: string, opts: HttpBackendOpts = {}): ProtocolBackend {
  const base = url.replace(/\/+$/, '')
  // Без привязки к globalThis браузер бросает «Illegal invocation».
  const maybeFetch = opts.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  if (typeof maybeFetch !== 'function') {
    throw new Error('createHttpBackend: fetch недоступен — передай opts.fetch')
  }
  const doFetch: typeof globalThis.fetch = maybeFetch

  /** Общий abort: close() рвёт все живые запросы и стримы. */
  const lifetime = new AbortController()
  let closed = false

  let capsCache: { value: Capabilities; at: number } | null = null

  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const base = typeof opts.headers === 'function' ? await opts.headers() : (opts.headers ?? {})
    const auth: Record<string, string> = opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}
    return { ...auth, ...base, ...extra }
  }

  function ensureOpen(): void {
    if (closed) throw new Error('createHttpBackend: backend закрыт (close())')
  }

  /** Запрос + разбор Envelope §4. Ошибка провода → throw (§2: фатальное). */
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ result: T; version?: string }> {
    ensureOpen()
    const headers = await buildHeaders(
      body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    )

    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: lifetime.signal,
      })
    } catch (err) {
      throw new BackendError(`${method} ${path}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    const text = await res.text()
    let envelope: WireEnvelope<T> | null = null
    try {
      envelope = text === '' ? null : (JSON.parse(text) as WireEnvelope<T>)
    } catch {
      envelope = null
    }

    if (!envelope || typeof envelope.ok !== 'boolean') {
      throw new BackendError(
        `${method} ${path}: ответ не Envelope (HTTP ${res.status})`,
        undefined,
        res.status,
      )
    }
    if (!envelope.ok) throw toError(envelope, res.status)

    return { result: envelope.result as T, version: envelope.version }
  }

  const backend: ProtocolBackend = {
    async capabilities(): Promise<Capabilities> {
      const ttl = opts.capabilitiesTtl
      if (capsCache && (ttl === undefined || Date.now() - capsCache.at < ttl)) {
        return capsCache.value
      }
      const { result } = await call<Capabilities>('GET', '/capabilities')
      capsCache = { value: result, at: Date.now() }
      return result
    },

    sessions: {
      async list(): Promise<SessionInfo[]> {
        return (await call<SessionInfo[]>('GET', '/sessions')).result
      },
      async create(createOpts?: SessionCreateOpts): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', '/sessions', createOpts ?? {})).result
      },
      async get(id: string): Promise<SessionInfo> {
        return (await call<SessionInfo>('GET', `/sessions/${enc(id)}`)).result
      },
      async delete(id: string): Promise<void> {
        await call<void>('DELETE', `/sessions/${enc(id)}`)
      },
      async fork(id: string, atMessageId?: string): Promise<SessionInfo> {
        return (await call<SessionInfo>('POST', `/sessions/${enc(id)}/fork`, { atMessageId })).result
      },
      async rename(id: string, title: string): Promise<void> {
        await call<void>('PATCH', `/sessions/${enc(id)}`, { title })
      },
    },

    async history(id: string): Promise<HistoryPage> {
      const { result, version } = await call<HistoryPage>('GET', `/sessions/${enc(id)}/history`)
      return { messages: result.messages, version: result.version ?? version ?? '' }
    },

    run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
      return streamRun(id, input)
    },

    async cancel(id: string, runId: string): Promise<void> {
      await call<void>('POST', `/sessions/${enc(id)}/cancel`, { runId })
    },

    async respond(id: string, askId: string, answer: unknown): Promise<void> {
      await call<void>('POST', `/sessions/${enc(id)}/respond`, { askId, answer })
    },

    messages: {
      async append(sid: string, parts: Part[], appendOpts?: MessageAppendOpts): Promise<Message> {
        const body: { parts: Part[]; role?: string; swipeOf?: string } = { parts }
        if (appendOpts?.role) body.role = appendOpts.role
        if (appendOpts?.swipeOf) body.swipeOf = appendOpts.swipeOf
        return (await call<Message>('POST', `/sessions/${enc(sid)}/messages`, body)).result
      },
      async edit(sid: string, mid: string, patch: MessageEditPatch): Promise<Message> {
        return (await call<Message>('PATCH', `/sessions/${enc(sid)}/messages/${enc(mid)}`, patch)).result
      },
      async delete(sid: string, mid: string): Promise<void> {
        await call<void>('DELETE', `/sessions/${enc(sid)}/messages/${enc(mid)}`)
      },
      async hide(sid: string, mid: string, hidden: boolean): Promise<void> {
        await call<void>('POST', `/sessions/${enc(sid)}/messages/${enc(mid)}/hide`, { hidden })
      },
      async swipe(sid: string, mid: string, to: SwipeTo): Promise<Message> {
        return (await call<Message>('POST', `/sessions/${enc(sid)}/messages/${enc(mid)}/swipe`, to)).result
      },
      async prompt(sid: string, mid: string): Promise<PromptView> {
        return (await call<PromptView>('GET', `/sessions/${enc(sid)}/messages/${enc(mid)}/prompt`)).result
      },
    },

    // models (models-spec §4): как остальные опциональные ops — метод есть
    // всегда, «не умею» приезжает от бэкенда за проводом (not_supported).
    models: {
      async list(): Promise<ModelInfo[]> {
        return (await call<ModelInfo[]>('GET', '/models')).result
      },
      async set(sessionId: string, model: SessionModel): Promise<SessionModel> {
        return (await call<SessionModel>('POST', `/sessions/${enc(sessionId)}/model`, model)).result
      },
    },

    // workspace (workspace-spec §3): current/list всегда, switch — гейт
    // capability `workspace.switch`; незаявленный приезжает not_supported.
    // services (plugin-services-spec §2, v1.11): незаявленное — not_supported с сервера.
    services: {
      async call(plugin: string, method: string, args?: unknown): Promise<unknown> {
        const path = `/services/${enc(plugin)}/${enc(method)}`
        return (await call<unknown>('POST', path, args === undefined ? {} : { args })).result
      },
      stream(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> {
        return streamService(plugin, method, args)
      },
      // v1.14: HTTP сервиса — тем же адресом, что бэкенд (туннель, чужое устройство).
      url(plugin: string, path: string): string {
        const rest = path.split('/').filter((s) => s !== '').map(enc).join('/')
        return `${base}/services/${enc(plugin)}/http/${rest}${path.endsWith('/') && rest ? '/' : ''}`
      },
    },

    workspace: {
      async current(): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('GET', '/workspace')).result
      },
      async list(): Promise<WorkspaceInfo[]> {
        return (await call<WorkspaceInfo[]>('GET', '/workspaces')).result
      },
      async switch(id: string): Promise<WorkspaceInfo> {
        return (await call<WorkspaceInfo>('POST', '/workspace', { id })).result
      },

      // files (workspace-files-spec §1): все методы всегда; незаявленное
      // приезжает not_supported. watch — SSE с переподключением.
      files: {
        async list(path?: string): Promise<FileEntry[]> {
          return (await call<FileEntry[]>('GET', `/workspace/files${query({ path })}`)).result
        },
        async read(path: string, readOpts?: FileReadOpts): Promise<FileContent> {
          return (await call<FileContent>('GET', `/workspace/file${query({ path, maxBytes: readOpts?.maxBytes })}`)).result
        },
        async write(path: string, content: string, writeOpts?: FileWriteOpts): Promise<{ revision: string }> {
          const body: { path: string; content: string; encoding?: string; revision?: string | null } = { path, content }
          if (writeOpts?.encoding !== undefined) body.encoding = writeOpts.encoding
          // null («создать») обязан доехать; undefined — поля нет вовсе.
          if (writeOpts?.revision !== undefined) body.revision = writeOpts.revision
          return (await call<{ revision: string }>('PUT', '/workspace/file', body)).result
        },
        async delete(path: string): Promise<void> {
          await call<void>('DELETE', `/workspace/file${query({ path })}`)
        },
        async rename(from: string, to: string): Promise<void> {
          await call<void>('POST', '/workspace/file/rename', { from, to })
        },
        async stat(path: string): Promise<FileEntry> {
          return (await call<FileEntry>('GET', `/workspace/file/stat${query({ path })}`)).result
        },
        watch(listener: WorkspaceUpdateListener): () => void {
          return watchWorkspace(listener)
        },
      },
    },

    // profiles (profiles-spec §4): list всегда, set — гейт `profiles.switch`;
    // незаявленный приезжает not_supported.
    profiles: {
      async list(): Promise<ProfileInfo[]> {
        return (await call<ProfileInfo[]>('GET', '/profiles')).result
      },
      // Встроенный профиль (bot-as-session-spec §1) едет документом: {doc}, не {id}.
      async set(sessionId: string, profile: string | ProfileDoc): Promise<ProfileInfo> {
        const body = typeof profile === 'string' ? { id: profile } : { doc: profile }
        return (await call<ProfileInfo>('POST', `/sessions/${enc(sessionId)}/profile`, body)).result
      },
      // Конструктор (profile-editor-spec §3): save/delete/duplicate — гейт `profiles.edit`.
      async get(id: string): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('GET', `/profiles/${enc(id)}`)).result
      },
      async save(doc: ProfileDoc): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('PUT', `/profiles/${enc(doc.id)}`, doc)).result
      },
      async delete(id: string): Promise<void> {
        await call<void>('DELETE', `/profiles/${enc(id)}`)
      },
      async duplicate(id: string, newId: string): Promise<ProfileDoc> {
        return (await call<ProfileDoc>('POST', `/profiles/${enc(id)}/duplicate`, { id: newId })).result
      },
    },

    // catalogs (profile-editor-spec §3): все три всегда; незаявленный вид
    // приезжает not_supported.
    catalogs: {
      async tools(): Promise<CatalogTool[]> {
        return (await call<CatalogTool[]>('GET', '/catalogs/tools')).result
      },
      async skills(): Promise<CatalogSkill[]> {
        return (await call<CatalogSkill[]>('GET', '/catalogs/skills')).result
      },
      async extensions(): Promise<CatalogExtension[]> {
        return (await call<CatalogExtension[]>('GET', '/catalogs/extensions')).result
      },
    },

    catalog: {
      async bots(): Promise<unknown[]> {
        return (await call<unknown[]>('GET', '/bots')).result
      },
      async bot(id: string): Promise<unknown> {
        return (await call<unknown>('GET', `/bots/${enc(id)}`)).result
      },
      async asset(botId: string, file: string): Promise<AssetData> {
        return fetchAsset(botId, file)
      },
    },

    // personas-spec §3: документ персон сессии целиком — и на чтение, и на запись.
    personas: {
      async list(sid: string): Promise<PersonasDoc> {
        return (await call<PersonasDoc>('GET', `/sessions/${enc(sid)}/personas`)).result
      },
      async save(sid: string, personas: Persona[], userId?: string): Promise<PersonasDoc> {
        const body = userId === undefined ? { personas } : { personas, userId }
        return (await call<PersonasDoc>('PUT', `/sessions/${enc(sid)}/personas`, body)).result
      },
    },

    meta: {
      async get(id: string): Promise<SessionMetaDoc> {
        return (await call<SessionMetaDoc>('GET', `/sessions/${enc(id)}/meta`)).result as SessionMetaDoc
      },
      async patch(id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc> {
        // Возвращается ПРИМЕНЁННЫЙ документ (§2) — клиенту не нужно повторять
        // merge у себя, чтобы узнать, что получилось.
        return (await call<SessionMetaDoc>('PATCH', `/sessions/${enc(id)}`, { meta: patch })).result as SessionMetaDoc
      },
    },

    attachments: {
      async put(sid: string, name: string, data: Uint8Array, mime?: string): Promise<AttachmentPutResult> {
        return putAttachment(sid, name, data, mime)
      },
      async get(sid: string, ref: string): Promise<AttachmentContent> {
        return (await call<AttachmentContent>('GET', `/sessions/${enc(sid)}/attachments/${enc(ref)}`)).result
      },
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      capsCache = null
      lifetime.abort()
    },
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ассет — единственный не-Envelope роут (§9: байты, не JSON)
  // ──────────────────────────────────────────────────────────────────────────

  async function putAttachment(
    sid: string,
    name: string,
    data: Uint8Array,
    mime?: string,
  ): Promise<AttachmentPutResult> {
    ensureOpen()
    const headers = await buildHeaders({
      accept: 'application/json',
      'content-type': mime ?? 'application/octet-stream',
      'x-name': encodeURIComponent(name),
    })

    let res: Response
    try {
      // Копия в свежий Uint8Array: у fetch BodyInit — ArrayBufferView, а вьюшка
      // над пулом Buffer'а могла бы уехать за пределы своего среза.
      res = await doFetch(`${base}/sessions/${enc(sid)}/attachments`, {
        method: 'POST',
        headers,
        body: data.slice(),
        signal: lifetime.signal,
      })
    } catch (err) {
      throw new BackendError(`attachments.put ${sid}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    const text = await res.text()
    const envelope = safeEnvelope(text) as WireEnvelope<AttachmentPutResult> | null
    if (!envelope || typeof envelope.ok !== 'boolean') {
      throw new BackendError(
        `attachments.put ${sid}: ответ не Envelope (HTTP ${res.status})`,
        undefined,
        res.status,
      )
    }
    if (!envelope.ok) throw toError(envelope, res.status)
    return envelope.result as AttachmentPutResult
  }

  async function fetchAsset(botId: string, file: string): Promise<AssetData> {
    ensureOpen()
    const res = await doFetch(`${base}/bots/${enc(botId)}/assets/${enc(file)}`, {
      method: 'GET',
      headers: await buildHeaders(),
      signal: lifetime.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw toError(safeEnvelope(text), res.status)
    }
    const mime = res.headers.get('content-type') ?? undefined
    return { data: new Uint8Array(await res.arrayBuffer()), mime: mime ?? undefined }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // watch — GET /workspace/events → workspace_update (workspace-files-spec §1)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Подписка на изменения файлов. Синхронная (протокол: `watch → unsubscribe`),
   * канал — фоном: обрыв и 5xx → переподключение с backoff, и после любого
   * подключения, кроме первого, подписчик получает `paths: ['']` — что было
   * между, неизвестно. 4xx и not_supported — канала нет и не будет: без ретраев.
   */
  function watchWorkspace(listener: WorkspaceUpdateListener): () => void {
    ensureOpen()
    const ac = new AbortController()
    const onClose = () => ac.abort()
    lifetime.signal.addEventListener('abort', onClose, { once: true })

    const deliver = (event: WorkspaceUpdateEvent) => {
      if (ac.signal.aborted) return
      try {
        listener(event)
      } catch {
        // упавший подписчик — его дело, канал живёт
      }
    }

    void (async () => {
      let attempt = 0
      let backoff = 0
      while (!ac.signal.aborted) {
        if (backoff > 0) await sleep(backoff, ac.signal)
        if (ac.signal.aborted) break
        backoff = Math.min(WATCH_BACKOFF_MAX_MS, backoff ? backoff * 2 : WATCH_BACKOFF_MS)

        let res: Response
        try {
          res = await doFetch(`${base}/workspace/events`, {
            method: 'GET',
            headers: await buildHeaders({ accept: 'text/event-stream' }),
            signal: ac.signal,
          })
        } catch {
          attempt++
          continue
        }
        if (!res.ok || !isEventStream(res) || !res.body) {
          await res.text().catch(() => '')
          if (res.status < 500 || res.status === 501) break
          attempt++
          continue
        }

        if (attempt > 0) deliver({ type: 'workspace_update', paths: [''] })
        attempt++
        backoff = WATCH_BACKOFF_MS

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
            let cut: number
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
              const event = parseWorkspaceEvent(buffer.slice(0, cut))
              buffer = buffer.slice(cut + 2)
              if (event) deliver(event)
            }
          }
        } catch {
          // обрыв провода или abort — решает условие цикла
        } finally {
          await reader.cancel().catch(() => {})
        }
      }
      lifetime.signal.removeEventListener('abort', onClose)
    })()

    return () => ac.abort()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // services.stream — POST → SSE service_event … service_end (v1.11)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Стрим сервиса. Отказ до стрима (not_supported) — throw первого `next()`;
   * соединение кончилось без `service_end` — кадр `error` с `connection_lost`.
   * `return()` рвёт соединение сразу, даже посреди ожидания кадра: сервер
   * видит закрытие и абортит сервис.
   */
  function streamService(plugin: string, method: string, args: unknown): AsyncIterable<ServiceEvent> {
    return {
      [Symbol.asyncIterator]() {
        const ac = new AbortController()
        const inner = readServiceStream(plugin, method, args, ac.signal)
        return {
          next: () => inner.next(),
          async return() {
            ac.abort()
            await inner.return(undefined).catch(() => {})
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  async function* readServiceStream(
    plugin: string,
    method: string,
    args: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<ServiceEvent, void> {
    ensureOpen()
    const path = `/services/${enc(plugin)}/${enc(method)}/stream`
    const ac = new AbortController()
    const onClose = () => ac.abort()
    signal.addEventListener('abort', onClose, { once: true })
    lifetime.signal.addEventListener('abort', onClose, { once: true })
    try {
      let res: Response
      try {
        res = await doFetch(`${base}${path}`, {
          method: 'POST',
          headers: await buildHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
          body: JSON.stringify(args === undefined ? {} : { args }),
          signal: ac.signal,
        })
      } catch (err) {
        if (signal.aborted) return
        throw new BackendError(`services.stream ${plugin}.${method}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
      }
      if (!res.ok || !isEventStream(res) || !res.body) {
        const text = await res.text().catch(() => '')
        throw toError(safeEnvelope(text), res.status)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (err) {
            if (signal.aborted) return
            yield serviceErrorEvent(err, CODE_CONNECTION_LOST)
            return
          }
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
          let cut: number
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const frame = parseServiceFrame(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 2)
            if (frame?.type === 'end') return
            if (frame) yield frame.event
          }
        }
        const tail = parseServiceFrame(buffer + decoder.decode())
        if (tail?.type === 'end') return
        if (tail) yield tail.event
        if (!signal.aborted) yield serviceErrorEvent('stream ended without service_end', CODE_CONNECTION_LOST)
      } finally {
        await reader.cancel().catch(() => {})
      }
    } finally {
      signal.removeEventListener('abort', onClose)
      lifetime.signal.removeEventListener('abort', onClose)
      ac.abort() // соединение закрыто — сервер абортит сервис, если он ещё жив
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // run — POST → SSE-стрим → AsyncIterable<AnyRunEvent> (§5.2, §9)
  // ──────────────────────────────────────────────────────────────────────────

  async function* streamRun(id: string, input: RunStartInput): AsyncGenerator<AnyRunEvent> {
    ensureOpen()

    let res: Response
    try {
      res = await doFetch(`${base}/sessions/${enc(id)}/run`, {
        method: 'POST',
        headers: await buildHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
        body: JSON.stringify(input ?? {}),
        signal: lifetime.signal,
      })
    } catch (err) {
      // Ран не стартовал — транспортная авария (§2: throw, не run_end)
      throw new BackendError(`run ${id}: ${errorMessage(err)}`, CODE_CONNECTION_LOST)
    }

    if (!res.ok || !isEventStream(res)) {
      // Сервер отказал до стрима (not_supported, busy, 500) — Envelope
      const text = await res.text().catch(() => '')
      throw toError(safeEnvelope(text), res.status)
    }
    if (!res.body) throw new BackendError(`run ${id}: пустой стрим (HTTP ${res.status})`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastRunId = ''
    let sawRunEnd = false

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (err) {
          // Провод порвался посреди рана: не throw (ран мог доехать на сервере),
          // а синтетический run_end с кодом — UI различит и ресинкнется (§3.2).
          yield connectionLost(lastRunId, errorMessage(err))
          return
        }
        if (chunk.done) break

        buffer += decoder.decode(chunk.value, { stream: true })

        // Отдаём только целые кадры; хвост копится до следующего чтения.
        const cut = buffer.lastIndexOf('\n\n')
        if (cut === -1) continue
        const complete = buffer.slice(0, cut + 2)
        buffer = buffer.slice(cut + 2)

        for (const event of parseSSEStream(complete)) {
          if (typeof event.runId === 'string') lastRunId = event.runId
          if (event.type === 'run_end') sawRunEnd = true
          yield event // неизвестные типы — вверх opaque, не фильтруем (§1.2)
        }
      }

      // Хвост без завершающего разделителя (сервер закрылся сразу после кадра).
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const event of parseSSEStream(buffer)) {
          if (typeof event.runId === 'string') lastRunId = event.runId
          if (event.type === 'run_end') sawRunEnd = true
          yield event
        }
      }

      // Стрим кончился, а run_end не приехал — то же, что обрыв.
      if (!sawRunEnd) yield connectionLost(lastRunId, 'stream ended without run_end')
    } finally {
      // Отпускаем сокет. Ран на сервере при этом НЕ отменяется (§5.4) —
      // отмена только явным cancel().
      await reader.cancel().catch(() => {})
    }
  }

  return backend
}

// ────────────────────────────────────────────────────────────────────────────
// Хелперы
// ────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

/** Первая пауза переподключения канала `/workspace/events`, мс; дальше — удвоение. */
const WATCH_BACKOFF_MS = 500
const WATCH_BACKOFF_MAX_MS = 30_000

/** Query-строка: `undefined` пропускается, пусто — без `?`. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** Пауза, которую abort обрывает сразу. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream')
}

function safeEnvelope(text: string): WireEnvelope<unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as WireEnvelope<unknown>) : null
  } catch {
    return null
  }
}

/** Envelope-ошибка → исключение: not_supported восстанавливается классом (§3.1). */
function toError(envelope: WireEnvelope<unknown> | null, status: number): Error {
  const message = envelope?.error ?? `HTTP ${status}`
  if (envelope?.code === CODE_NOT_SUPPORTED) return new NotSupportedError(undefined, message)
  return new BackendError(message, envelope?.code, status)
}

/** Синтетический run_end обрыва (§3.2): version неизвестен → ресинк по history. */
function connectionLost(runId: string, message: string): AnyRunEvent {
  return {
    type: 'run_end',
    runId,
    status: 'error',
    error: { message, code: CODE_CONNECTION_LOST },
    version: '',
  }
}
