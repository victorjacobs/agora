// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import https from 'node:https'
import { createECDH, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import webpush from 'web-push'
import { HermesBridge } from '../server/bridge.ts'
import type { GatewayEvent, ServerRequest } from '../src/hermes/types.ts'

const ece = createRequire(import.meta.url)('http_ece')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks() })
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const until = async (condition: () => boolean) => { await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 12000, interval: 40 }) }

it('sends real encrypted Web Push after browser close, survives restart without duplicates and stops on logout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agora-push-runtime-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const db = join(directory, 'sessions.sqlite')
  const key = createECDH('prime256v1'); key.generateKeys()
  const auth = Buffer.alloc(16, 7)
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-device', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
  const delivered: Array<Record<string, string>> = []
  const encrypted: Buffer[] = []
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks); encrypted.push(bytes)
    expect(request.headers['content-encoding']).toBe('aes128gcm')
    expect(request.headers.authorization).toMatch(/^vapid t=/)
    expect(request.headers.ttl).toBe('120')
    delivered.push(JSON.parse(ece.decrypt(bytes, { version: 'aes128gcm', privateKey: key, authSecret: auth }).toString()))
    response.writeHead(201); response.end()
  })
  const receiverOrigin = await listen(receiver)
  // The production sender still constructs the allowlisted provider request; only its network transport is looped back.
  vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback: (response: any) => void) => httpRequest(receiverOrigin, { method: options.method, headers: options.headers }, callback)) as typeof https.request)

  let epoch = 'epoch-1'
  let events: GatewayEvent[] = []
  let requests: ServerRequest[] = []
  let replayReads = 0
  let revoked = false
  let challenge = ''
  const methods: string[] = []
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://upstream')
    const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/status') return send({ auth_flows: ['native_pkce'] })
    if (url.pathname === '/auth/native/authorize') {
      challenge = url.searchParams.get('code_challenge')!
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture')
      response.writeHead(302, { Location: callback.href }); response.end(); return
    }
    if (url.pathname === '/auth/native/token') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge)
      return send({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', provider: 'fixture', expires_at: Date.now() / 1000 + 3600 })
    }
    if (revoked || request.headers.authorization !== 'Bearer synthetic-access') return send({}, 401)
    if (url.pathname === '/api/auth/ws-ticket') return send({ ticket: 'single-use-fixture' })
    if (url.pathname === '/api/auth/me') return send({ display_name: 'Fictional operator' })
    if (url.pathname === '/api/sessions/stored') { expect(url.searchParams.get('profile')).toBe('work'); return send({ id: 'stored', title: 'Fictional project' }) }
    send({}, 404)
  })
  const endpoint = await listen(upstream)
  const sockets = new WebSocketServer({ server: upstream })
  cleanup.push(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close() })
  sockets.on('connection', (socket, request) => {
    expect(request.headers['sec-websocket-protocol']).toContain('hermes-gateway-ticket.single-use-fixture')
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: true } } }))
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()); methods.push(frame.method)
      let result: unknown
      if (frame.method === 'session.create') result = { session_id: 'draft-runtime', stored_session_id: 'draft-stored', messages: [], info: { profile_name: 'work', lazy: true } }
      else if (frame.method === 'session.resume') result = { session_id: 'runtime', session_key: 'stored', resumed: 'stored', messages: [], hydrating: true, info: { profile_name: 'work' } }
      else if (frame.method === 'session.events.since') {
        replayReads++
        expect(frame.params.session_id).toBe('runtime'); expect(frame.params.profile).toBe('work')
        result = { epoch, latest_seq: events.at(-1)?.seq || 0, truncated: false, events: events.filter(event => event.seq! > frame.params.last_seen), open_requests: requests }
      } else if (frame.method === 'gateway.ping') result = {}
      else throw new Error(`Forbidden observer execution RPC: ${frame.method}`)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
    })
  })
  const config = { ...webpush.generateVAPIDKeys(), subject: 'mailto:fixture@example.test' }
  let bridge = new HermesBridge(endpoint, fetch, { sessionDb: db, push: config })
  const server = createServer((request, response) => bridge.middleware(request, response, () => { response.writeHead(404); response.end() }))
  bridge.attach(server)
  const origin = await listen(server)
  cleanup.push(() => bridge.dispose())
  const beginning = await fetch(`${origin}/login`, { redirect: 'manual' })
  const loginCookie = beginning.headers.get('set-cookie')!.split(';')[0]!
  const authorization = await fetch(beginning.headers.get('location')!, { redirect: 'manual' })
  const completed = await fetch(authorization.headers.get('location')!, { redirect: 'manual', headers: { Cookie: loginCookie } })
  const cookie = completed.headers.getSetCookie().find(value => value.startsWith('agora_local_session='))!.split(';')[0]!
  const api = (method = 'GET', body?: unknown) => fetch(`${origin}/api/agora/push`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  expect((await api('POST', { subscription })).status).toBe(200)
  const browser = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], { headers: { Cookie: cookie, Origin: origin } })
  await once(browser, 'open')
  const snapshot = once(browser, 'message')
  browser.send(JSON.stringify({ jsonrpc: '2.0', id: 'resume', method: 'session.resume', params: { session_id: 'stored', profile: 'work', defer_history: true } }))
  await snapshot
  await until(() => replayReads > 0)
  expect((await (await api()).json()).watched).toBe(1)
  browser.close(); await once(browser, 'close')
  events.push({ session_id: 'runtime', type: 'message.complete', seq: 1, payload: { text: 'The fictional report is ready.', status: 'complete' } })
  await until(() => delivered.length === 1)
  expect(delivered[0]).toMatchObject({ title: 'Fictional project', body: 'The fictional report is ready.', url: '/?session=stored&profile=work' })
  expect(encrypted[0]!.includes(Buffer.from('fictional report'))).toBe(false)
  const persisted = readFileSync(db)
  expect(persisted.includes(Buffer.from('fictional report'))).toBe(false)
  expect(persisted.includes(Buffer.from('Fictional project'))).toBe(false)
  expect(persisted.includes(Buffer.from(cookie.split('=')[1]!))).toBe(false)
  bridge.dispose()
  bridge = new HermesBridge(endpoint, fetch, { sessionDb: db, push: config }); bridge.attach(server)
  const before = replayReads; await until(() => replayReads > before)
  expect(delivered).toHaveLength(1)
  requests = [{ id: 'request-1', method: 'sudo', params: { session_id: 'runtime', command: 'NEVER PREVIEW THIS COMMAND' } }]
  await until(() => delivered.length === 2)
  expect(delivered[1]).toMatchObject({ title: 'Hermes needs your attention', body: 'Hermes needs secure input. Open Agora to continue.' })
  expect(JSON.stringify(delivered)).not.toContain('NEVER PREVIEW')
  const reads = replayReads; await until(() => replayReads > reads)
  expect(delivered).toHaveLength(2)
  epoch = 'new-epoch'; events = [{ session_id: 'runtime', seq: 1, type: 'message.complete', payload: { text: 'Do not invent a missed reply.' } }]
  const previous = replayReads; await until(() => replayReads > previous)
  expect(delivered).toHaveLength(2)
  const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, redirect: 'manual' })
  expect(logout.status).toBe(303)
  expect((await api()).status).toBe(401)
  bridge.dispose(); bridge = new HermesBridge(endpoint, fetch, { sessionDb: db, push: config }); bridge.attach(server)
  expect((await api()).status).toBe(401)
  expect(methods.every(method => ['session.resume', 'session.events.since', 'gateway.ping'].includes(method))).toBe(true)
}, 40000)
