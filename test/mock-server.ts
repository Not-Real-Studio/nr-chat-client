/**
 * Mock-сервер HTTP-биндинга §9: ровно то, что нужно клиенту, по сценарию
 * теста. Пишет все запросы (метод, путь, заголовки, тело) — тест проверяет
 * провод, а не реализацию бэкенда.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

export type RunScript = (ctl: { body: any; write(frame: object): void; comment(text: string): void; end(): void; raw(text: string): void; cancelled: Promise<string> }) => Promise<void> | void

export interface MockOpts {
  authKey?: string
  run?: RunScript
}

export interface Mock {
  url: string
  seen: Seen[]
  close(): Promise<void>
}

export async function startMock(opts: MockOpts = {}): Promise<Mock> {
  const seen: Seen[] = []
  const sessions: Array<{ id: string; title?: string }> = []
  const metas = new Map<string, Record<string, unknown>>()
  let cancel: (runId: string) => void = () => {}

  const send = (res: ServerResponse, status: number, body: object): void => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(json)
  }

  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const url = new URL(req.url ?? '/', 'http://x')
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body })
    if (opts.authKey && req.headers.authorization !== `Bearer ${opts.authKey}`) {
      return send(res, 401, { ok: false, error: 'unauthorized', code: 'unauthorized' })
    }
    const segs = url.pathname.split('/').filter(Boolean)
    const ok = (result?: unknown, version?: string) => send(res, 200, { ok: true, result, ...(version ? { version } : {}) })

    if (url.pathname === '/capabilities') return ok({ protocol: 1, name: 'mock', cancel: true, ask: ['tool_approval'] })
    if (url.pathname === '/profiles') return ok([{ id: 'agent', name: 'Agent' }])
    if (url.pathname === '/models') return ok([{ id: 'm1', name: 'M1' }])
    if (url.pathname === '/sessions' && req.method === 'POST') {
      if (body?.profile === 'busy') return send(res, 409, { ok: false, error: 'busy', code: 'busy' })
      if (body?.cwd === 'rel') return send(res, 501, { ok: false, error: 'no cwd', code: 'not_supported' })
      const s = { id: `s${sessions.length + 1}`, ...(body?.title ? { title: body.title } : {}) }
      sessions.push(s)
      if (body?.cwd) metas.set(s.id, { workspace: { cwd: body.cwd } })
      return ok(s)
    }
    if (url.pathname === '/sessions') return ok(sessions)
    if (segs[0] === 'sessions' && segs.length === 2 && req.method === 'GET') return ok(sessions.find((s) => s.id === segs[1]))
    if (segs[0] === 'sessions' && segs.length === 2 && req.method === 'PATCH') {
      const next = { ...(metas.get(segs[1]!) ?? {}), ...(body?.meta ?? {}) }
      metas.set(segs[1]!, next)
      return ok(next)
    }
    if (segs[2] === 'meta') return ok(metas.get(segs[1]!) ?? {})
    if (segs[2] === 'history') return ok({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, 'v7')
    if (segs[2] === 'respond') return ok()
    if (segs[2] === 'cancel') {
      cancel(body?.runId)
      return ok()
    }
    if (segs[2] === 'run') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' })
      const cancelled = new Promise<string>((r) => (cancel = r))
      await opts.run?.({
        body,
        write: (frame) => res.write(`event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`),
        comment: (text) => res.write(`: ${text}\n\n`),
        raw: (text) => res.write(text),
        end: () => res.end(),
        cancelled,
      })
      if (!res.writableEnded) res.end()
      return
    }
    send(res, 404, { ok: false, error: 'no route', code: 'not_found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
