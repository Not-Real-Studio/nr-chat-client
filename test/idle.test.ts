/**
 * Сторож тишины вечных стримов (DEV-243): сервер пингует — стрим жив; ни байта
 * дольше `idleTimeoutMs` — стрим сервиса кончается кадром connection_lost
 * (рестарт бэкенда за туннелем оставлял соединение висеть вечно).
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpBackend } from '../src/index.js'

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

async function serve(pingMs: number | null): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: service_event\ndata: ${JSON.stringify({ name: 'ready' })}\n\n`)
    if (pingMs !== null) {
      const t = setInterval(() => res.write(': ping\n\n'), pingMs)
      req.on('close', () => clearInterval(t))
    }
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

describe('services.stream: сторож тишины', () => {
  it('тишина дольше idleTimeoutMs — кадр error connection_lost и конец', async () => {
    const b = createHttpBackend(await serve(null), { idleTimeoutMs: 150 })
    const frames: { name: string; payload?: any }[] = []
    for await (const f of b.services!.stream('p', 'events')) frames.push(f)
    expect(frames[0]).toEqual({ name: 'ready' })
    expect(frames[1]?.name).toBe('error')
    expect(JSON.stringify(frames[1]?.payload)).toMatch(/connection_lost/)
    expect(JSON.stringify(frames[1]?.payload)).toMatch(/heartbeat/)
    b.close?.()
  })

  it('пинги чаще порога — стрим жив', async () => {
    const b = createHttpBackend(await serve(40), { idleTimeoutMs: 150 })
    const it = b.services!.stream('p', 'events')[Symbol.asyncIterator]()
    expect((await it.next()).value).toEqual({ name: 'ready' })
    const raced = await Promise.race([it.next().then(() => 'frame'), new Promise((r) => setTimeout(() => r('alive'), 500))])
    expect(raced).toBe('alive')
    await it.return?.()
    b.close?.()
  })
})
