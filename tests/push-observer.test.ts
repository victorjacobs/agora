// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import webpush from 'web-push'
import { NativeSession } from '../server/native-session.ts'
import { SessionStore, sessionOwner } from '../server/session-store.ts'
import { PushObserver } from '../server/push-observer.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks() })
async function fixture(reply: (runtime: string, id: string, socket: any) => void) {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const sockets = new WebSocketServer({ server })
  cleanup.push(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close() })
  const reads: string[] = []
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString())
      expect(frame.method).toBe('session.events.since')
      reads.push(frame.params.session_id)
      reply(frame.params.session_id, frame.id, socket)
    })
  })
  const store = new SessionStore(':memory:', 'fixture')
  cleanup.push(() => store.close())
  const owner = sessionOwner('cookie')
  store.save('cookie', { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600, provider: 'fixture' }, Date.now())
  store.saveSubscription(owner, { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } })
  for (const runtime of ['a-failing', 'b-healthy']) store.saveWatch(owner, { runtime, stored: runtime + '-stored', profile: 'work', epoch: 'epoch', seq: 0, seen: [] })
  let revoked = false
  let titleFailure = false
  const native = new NativeSession(new URL(`http://127.0.0.1:${(server.address() as any).port}/`), (async (url: URL) => {
    if (url.pathname === '/auth/native/refresh') return new Response('{}', { status: 401 })
    if (url.pathname === '/api/auth/me') return new Response('{}', { status: revoked ? 401 : 200 })
    if (url.pathname === '/api/auth/ws-ticket') return Response.json({ ticket: 'fixture' })
    if (url.pathname.includes('/api/sessions/')) return titleFailure ? new Response('invalid JSON') : Response.json({ title: 'Fixture' })
    throw new Error('Forbidden observer HTTP call')
  }) as typeof fetch, { tokens: { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600, provider: 'fixture' } })
  const revoke = vi.fn()
  const observer = new PushObserver(owner, native, store, { ...webpush.generateVAPIDKeys(), subject: 'mailto:fixture@example.test' }, () => true, () => { revoke(); observer.stop() })
  cleanup.push(() => observer.stop())
  clearTimeout((observer as any).timer)
  return { store, owner, reads, observer, revoke, revokeAuth: () => { revoked = true }, failTitle: () => { titleFailure = true }, async sweep() {
    await (observer as any).tick(); clearTimeout((observer as any).timer)
  } }
}
const replay = (seq = 1) => ({ epoch: 'epoch', latest_seq: seq, truncated: false, events: [], open_requests: [] })
const send = (socket: any, id: string, result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))

it.each(['empty', 'reply'])('does not recreate an evicted watch when its in-flight %s replay settles', async kind => {
  const delivery = vi.spyOn(webpush, 'generateRequestDetails')
  const watch = (runtime: string) => ({ runtime, stored: runtime + '-stored', profile: 'work', epoch: 'epoch', seq: 0, seen: [] })
  const test = await fixture((runtime, id, socket) => {
    if (runtime === 'a-failing') {
      test.store.saveWatch(test.owner, watch('f-new'))
      send(socket, id, { ...replay(), events: kind === 'reply' ? [{ session_id: runtime, type: 'message.complete', seq: 1, payload: { text: 'An evicted reply must not notify.' } }] : [] })
    } else send(socket, id, replay())
  })
  for (const runtime of ['c', 'd', 'e']) test.store.saveWatch(test.owner, watch(runtime))
  await test.sweep()
  expect(test.store.watches(test.owner).map(row => row.runtime).sort()).toEqual(['b-healthy', 'c', 'd', 'e', 'f-new'])
  expect(delivery).not.toHaveBeenCalled()
})

it('accepts a retained 4 MiB event plus its full wire envelope and still reads the healthy follower', async () => {
  const event = { session_id: 'a-failing', type: 'message.delta', payload: { text: '' } }
  event.payload.text = 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(event)))
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(4 * 1024 * 1024)
  const result = { ...replay(), events: [{ ...event, seq: 1 }] }
  expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'agora-1', result }))).toBeGreaterThan(4 * 1024 * 1024)
  const primaryFrame = process.env.AGORA_REPLAY_FIXTURE_FILE && readFileSync(process.env.AGORA_REPLAY_FIXTURE_FILE, 'utf8')
  if (primaryFrame) expect(Buffer.byteLength(primaryFrame)).toBeGreaterThan(4 * 1024 * 1024)
  const test = await fixture((runtime, id, socket) => {
    if (runtime === 'a-failing' && primaryFrame) { expect(id).toBe('agora-1'); socket.send(primaryFrame) }
    else send(socket, id, runtime === 'a-failing' ? result : replay())
  })
  await test.sweep()
  expect(test.reads).toEqual(['a-failing', 'b-healthy'])
  expect(test.store.watches(test.owner).map(watch => watch.seq)).toEqual([1, 1])
  expect(test.observer.status).toBe('watching')
})

it('backs off RPC, disconnect and postprocessing failures without starving healthy watches or advancing failed cursors', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let failure = 'rpc'
  const test = await fixture((runtime, id, socket) => {
    if (runtime === 'b-healthy') return send(socket, id, replay())
    if (failure === 'rpc') return socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 4007, message: 'Unavailable session' } }))
    if (failure === 'disconnect') return socket.close()
    if (failure === 'oversized') return send(socket, id, { ...replay(), open_requests: [{ id: 'oversized', method: 'clarify', params: { text: 'x'.repeat(17 * 1024 * 1024) } }] })
    send(socket, id, { ...replay(), events: [{ session_id: runtime, type: 'message.complete', seq: 1, payload: { text: 'Never persist failed postprocessing' } }] })
  })
  await test.sweep()
  expect(test.reads).toEqual(['a-failing', 'b-healthy'])
  await test.sweep()
  expect(test.reads).toEqual(['a-failing', 'b-healthy', 'b-healthy'])
  now += 61_000; failure = 'disconnect'
  await test.sweep()
  const afterDisconnect = test.reads.length
  now += 61_000
  await test.sweep()
  expect(test.reads.slice(afterDisconnect)).toEqual(['b-healthy', 'a-failing'])
  await test.sweep()
  expect(test.reads.at(-1)).toBe('b-healthy')
  now += 61_000; failure = 'oversized'
  await test.sweep()
  const afterOversized = test.reads.length
  await test.sweep()
  expect(test.reads.slice(afterOversized)).toEqual(['b-healthy'])
  now += 61_000; failure = 'postprocessing'; test.failTitle()
  const beforePostprocessing = test.reads.length
  await test.sweep()
  expect(test.reads.slice(beforePostprocessing)).toEqual(['a-failing', 'b-healthy'])
  expect(test.store.watches(test.owner).find(watch => watch.runtime === 'a-failing')).toMatchObject({ seq: 0, seen: [] })
  expect(test.store.watches(test.owner).find(watch => watch.runtime === 'b-healthy')?.seq).toBe(1)
  test.revokeAuth(); now += 31_000
  const beforeRevocation = test.reads.length
  await test.sweep()
  expect(test.revoke).toHaveBeenCalledOnce()
  expect(test.observer.status).toBe('off')
  expect(test.reads).toHaveLength(beforeRevocation)
})
