/**
 * Провод HTTP-биндинга (§4, §9 спеки протокола) — то, что клиенту нужно в
 * рантайме: коды ошибок Envelope, классы ошибок, разбор SSE-кадров.
 *
 * Копия формы из nr-ui-protocol (sse.ts, services.ts, files.ts) — пакет не
 * тянет протокол в рантайм (ноль зависимостей, бандл виджета). Классы ошибок
 * совместимы по форме: `NotSupportedError` протокола узнаёт наш через
 * `instanceof` (name + code, протокол ≥0.27).
 */

import type { AnyRunEvent, ServiceEvent, WorkspaceUpdateEvent } from '@notrealstudio/nr-ui-protocol'

/** Envelope §4 на проводе: + `code` ошибки. */
export interface WireEnvelope<T> {
  ok: boolean
  result?: T
  error?: string
  version?: string
  code?: string
}

export const CODE_NOT_SUPPORTED = 'not_supported'
export const CODE_CONNECTION_LOST = 'connection_lost'
export const CODE_UNAUTHORIZED = 'unauthorized'

/** Ошибка бэкенда, доехавшая через Envelope (§4). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/**
 * «Операция не поддержана» (backends-spec §2, code `not_supported`). Та же
 * форма, что `NotSupportedError` протокола: `err instanceof NotSupportedError`
 * из `@notrealstudio/nr-ui-protocol` (≥0.27) верно и для этого класса.
 */
export class NotSupportedError extends Error {
  readonly code = CODE_NOT_SUPPORTED
  readonly operation?: string
  constructor(operation?: string, message?: string) {
    super(message ?? (operation ? `Operation not supported: ${operation}` : 'Operation not supported'))
    this.name = 'NotSupportedError'
    this.operation = operation
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'NotSupportedError' && (value as { code?: unknown }).code === CODE_NOT_SUPPORTED
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── SSE ────────────────────────────────────────────────────────────────────

interface Frame {
  event: string
  data: string
}

/** Один SSE-кадр → поля `event` и склеенный `data` (комментарии и пустые строки — мимо). */
function parseFrame(frame: string): Frame {
  let event = ''
  const data: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return { event, data: data.join('\n').trim() }
}

/** Кадр рана → событие; битый или пустой — `null` (§5.2: неизвестное игнорируется, не роняет). */
export function parseRunEvent(frame: string): AnyRunEvent | null {
  const { data } = parseFrame(frame)
  if (data === '') return null
  try {
    const parsed = JSON.parse(data)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null
    return parsed as AnyRunEvent
  } catch {
    return null
  }
}

/** Текст из нескольких кадров → события (кадры — через пустую строку). */
export function parseSSEStream(text: string): AnyRunEvent[] {
  const out: AnyRunEvent[] = []
  for (const frame of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    if (frame.trim() === '') continue
    const ev = parseRunEvent(frame)
    if (ev) out.push(ev)
  }
  return out
}

/** Кадр `/workspace/events` → `workspace_update`; чужой — `null`. */
export function parseWorkspaceEvent(frame: string): WorkspaceUpdateEvent | null {
  const v = parseRunEvent(frame) as unknown as { type?: unknown; paths?: unknown } | null
  if (!v || v.type !== 'workspace_update' || !Array.isArray(v.paths) || !v.paths.every((p) => typeof p === 'string')) return null
  return { type: 'workspace_update', paths: [...(v.paths as string[])] }
}

export type ServiceFrame = { type: 'event'; event: ServiceEvent } | { type: 'end' }

/** Кадр стрима сервиса: `service_event` → событие, `service_end` → конец, прочее — `null`. */
export function parseServiceFrame(frame: string): ServiceFrame | null {
  const { event, data } = parseFrame(frame)
  if (event === 'service_end') return { type: 'end' }
  if (event !== 'service_event') return null
  try {
    const parsed = JSON.parse(data) as { name?: unknown; payload?: unknown }
    if (!parsed || typeof parsed.name !== 'string' || parsed.name === '') return null
    const ev: ServiceEvent = { name: parsed.name }
    if (parsed.payload !== undefined) ev.payload = parsed.payload
    return { type: 'event', event: ev }
  } catch {
    return null
  }
}

/** Ошибка → кадр `error` сервиса. */
export function serviceErrorEvent(err: unknown, code?: string): ServiceEvent {
  const message = errorMessage(err)
  const own = (err as { code?: unknown } | null | undefined)?.code
  const c = code ?? (typeof own === 'string' && own !== '' ? own : undefined)
  return { name: 'error', payload: c !== undefined ? { message, code: c } : { message } }
}
