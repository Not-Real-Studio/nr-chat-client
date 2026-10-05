import { afterEach, describe, expect, it } from 'vitest'
import { NotSupportedError as ProtocolNotSupported, type AnyRunEvent } from '@notrealstudio/nr-ui-protocol'
import { BackendError, NotSupportedError, createClient, parseSSEStream, toRunInput } from '../src/index.js'
import { startMock, type Mock } from './mock-server.js'

let mock: Mock | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})

const R = 'r1'

describe('createClient', () => {
  it('сессии, мета, история, профили, модели — Envelope разворачивается', async () => {
    mock = await startMock()
    const c = createClient(mock.url + '/')
    expect(c.baseUrl).toBe(mock.url)
    expect((await c.capabilities()).name).toBe('mock')
    const s = await c.sessions.create({ title: 't', cwd: '/w' })
    expect(s).toEqual({ id: 's1', title: 't' })
    expect(await c.sessions.list()).toHaveLength(1)
    expect(await c.sessions.meta.get('s1')).toEqual({ workspace: { cwd: '/w' } })
    expect(await c.sessions.meta.patch('s1', { notes: 'n' })).toEqual({ workspace: { cwd: '/w' }, notes: 'n' })
    expect(mock.seen.at(-1)).toMatchObject({ method: 'PATCH', path: '/sessions/s1', body: { meta: { notes: 'n' } } })
    expect(await c.sessions.history('s1')).toMatchObject({ version: 'v7', messages: [{ id: 'm1' }] })
    expect(await c.profiles()).toEqual([{ id: 'agent', name: 'Agent' }])
    expect(await c.models()).toEqual([{ id: 'm1', name: 'M1' }])
    await c.respond('s1', 'a1', 'allow')
    expect(mock.seen.at(-1)).toMatchObject({ path: '/sessions/s1/respond', body: { askId: 'a1', answer: 'allow' } })
  })

  it('run: события по порядку в onEvent, результат — run_end; кадры, порезанные посреди, и комментарии', async () => {
    mock = await startMock({
      run: async ({ write, raw, comment, body }) => {
        expect(body).toEqual({ userMessage: 'привет', target: { kind: 'char', personaId: 'p1' } })
        write({ type: 'run_start', runId: R })
        comment('keepalive')
        write({ type: 'message_start', runId: R, message: { id: 'a', role: 'assistant' } })
        const frame = `event: part_delta\ndata: ${JSON.stringify({ type: 'part_delta', runId: R, messageId: 'a', part: 0, delta: 'При' })}\n\n`
        raw(frame.slice(0, 20))
        await new Promise((r) => setTimeout(r, 10))
        raw(frame.slice(20))
        write({ type: 'part_delta', runId: R, messageId: 'a', part: 0, delta: 'вет' })
        write({ type: 'run_end', runId: R, status: 'done', version: 'v2' })
      },
    })
    const c = createClient(mock.url)
    const seen: AnyRunEvent[] = []
    const end = await c.run('s1', 'привет', { target: { kind: 'char', personaId: 'p1' }, onEvent: (ev) => seen.push(ev) })
    expect(end).toMatchObject({ type: 'run_end', status: 'done', version: 'v2' })
    expect(seen.map((e) => e.type)).toEqual(['run_start', 'message_start', 'part_delta', 'part_delta', 'run_end'])
    expect(seen.filter((e) => e.type === 'part_delta').map((e) => (e as { delta: string }).delta).join('')).toBe('Привет')
  })

  it('signal: cancel уходит с runId, ран резолвится run_end cancelled', async () => {
    mock = await startMock({
      run: async ({ write, cancelled }) => {
        write({ type: 'run_start', runId: R })
        write({ type: 'message_start', runId: R, message: { id: 'a', role: 'assistant' } })
        const runId = await cancelled
        write({ type: 'run_end', runId, status: 'cancelled', version: 'v3' })
      },
    })
    const c = createClient(mock.url)
    const ac = new AbortController()
    const end = await c.run('s1', 'x', {
      signal: ac.signal,
      onEvent: (ev) => {
        if (ev.type === 'message_start') ac.abort()
      },
    })
    expect(end).toMatchObject({ status: 'cancelled', runId: R })
    expect(mock.seen.find((s) => s.path === '/sessions/s1/cancel')?.body).toEqual({ runId: R })
  })

  it('обрыв без run_end — синтетический run_end error connection_lost', async () => {
    mock = await startMock({ run: ({ write, end }) => (write({ type: 'run_start', runId: R }), end()) })
    const end = await createClient(mock.url).run('s1', 'x')
    expect(end).toMatchObject({ status: 'error', runId: R, error: { code: 'connection_lost' } })
  })

  it('auth: Bearer на каждом запросе и на SSE; без ключа — BackendError 401', async () => {
    mock = await startMock({ authKey: 'test-key-1', run: ({ write }) => write({ type: 'run_end', runId: R, status: 'done', version: '' }) })
    const c = createClient(mock.url, { auth: 'test-key-1' })
    await c.sessions.list()
    await c.run('s1', 'x')
    expect(mock.seen.every((s) => s.headers.authorization === 'Bearer test-key-1')).toBe(true)
    const bare = createClient(mock.url)
    const err = await bare.sessions.list().catch((e) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' })
    await expect(bare.run('s1', 'x')).rejects.toMatchObject({ status: 401 })
  })

  it('not_supported → NotSupportedError, и instanceof класса протокола', async () => {
    mock = await startMock()
    const err = await createClient(mock.url).sessions.create({ cwd: 'rel' }).catch((e) => e)
    expect(err).toBeInstanceOf(NotSupportedError)
    expect(err instanceof ProtocolNotSupported).toBe(true)
  })

  it('toRunInput и parseSSEStream', () => {
    expect(toRunInput('a')).toEqual({ userMessage: 'a' })
    expect(toRunInput([{ type: 'text', text: 'b' }], { kind: 'user' })).toEqual({ userMessage: [{ type: 'text', text: 'b' }], target: { kind: 'user' } })
    expect(toRunInput({ regenerate: { messageId: 'm' } })).toEqual({ regenerate: { messageId: 'm' } })
    expect(parseSSEStream('event: x\ndata: {"type":"x"}\n\n: c\n\ndata: bad\n\n')).toEqual([{ type: 'x' }])
  })
})
