import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createECDH } from 'node:crypto'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import webpush from 'web-push'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'agora-session-runtime-'))
const packagePath = process.argv[2] && resolve(process.argv[2])
let challenge = ''
let generation = 1
let expire = false
const ece = createRequire(import.meta.url)('http_ece')
const receiverKey = createECDH('prime256v1'); receiverKey.generateKeys()
const receiverAuth = Buffer.alloc(16, 9)
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/process-fixture', keys: { p256dh: receiverKey.getPublicKey().toString('base64url'), auth: receiverAuth.toString('base64url') } }
const deliveries = []
const receiver = createServer(async (request, response) => {
  const parts = []; for await (const part of request) parts.push(part)
  const encrypted = Buffer.concat(parts)
  assert.equal(request.headers['content-encoding'], 'aes128gcm')
  assert.match(request.headers.authorization, /^vapid t=/)
  assert.equal(encrypted.includes(Buffer.from('Fictional report')), false)
  deliveries.push(JSON.parse(ece.decrypt(encrypted, { version: 'aes128gcm', privateKey: receiverKey, authSecret: receiverAuth }).toString()))
  response.writeHead(201); response.end()
})
receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
const receiverOrigin = `http://127.0.0.1:${receiver.address().port}`
const vapidFile = join(directory, 'vapid.json')
await writeFile(vapidFile, JSON.stringify({ ...webpush.generateVAPIDKeys(), subject: 'mailto:fixture@example.test' }), { mode: 0o600 })
const preload = join(directory, 'push-loopback.mjs')
await writeFile(preload, `import https from 'node:https'; import http from 'node:http'; https.request = (options, callback) => http.request(process.env.AGORA_FIXTURE_PUSH_RECEIVER, { method: options.method, headers: options.headers }, callback);`)
const events = []
let replayReads = 0
const until = async condition => { const end = Date.now() + 12000; while (!condition()) { if (Date.now() > end) throw new Error('Push process fixture timed out'); await new Promise(resolve => setTimeout(resolve, 40)) } }

const upstream = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://synthetic.test')
  const send = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
  const body = async () => { const parts = []; for await (const part of request) parts.push(part); return JSON.parse(Buffer.concat(parts).toString()) }
  const tokens = () => ({ access_token: `synthetic-access-${generation}`, refresh_token: `synthetic-refresh-${generation}`, provider: 'synthetic', expires_at: Date.now() / 1000 + 3600 })
  if (url.pathname === '/api/status') return send({ auth_required: true, auth_flows: ['native_pkce'] })
  if (url.pathname === '/auth/native/authorize') {
    challenge = url.searchParams.get('code_challenge')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state') }).toString()
    response.writeHead(302, { Location: callback.href }); response.end(); return
  }
  if (url.pathname === '/auth/native/token') {
    const value = await body()
    assert.equal(createHash('sha256').update(value.code_verifier).digest('base64url'), challenge)
    assert.equal(value.code, 'synthetic-code')
    return send(tokens())
  }
  if (url.pathname === '/auth/native/refresh') {
    assert.equal((await body()).refresh_token, `synthetic-refresh-${generation}`)
    generation++
    return send(tokens())
  }
  if (expire) { expire = false; return send({}, 401) }
  if (request.headers.authorization !== `Bearer synthetic-access-${generation}`) return send({}, 401)
  if (url.pathname === '/api/auth/me') return send({ display_name: 'Synthetic operator' })
  if (url.pathname === '/api/auth/ws-ticket') return send({ ticket: 'fixture-ticket' })
  if (url.pathname === '/api/sessions/stored') { assert.equal(url.searchParams.get('profile'), 'work'); return send({ id: 'stored', title: 'Fictional project' }) }
  send({}, 404)
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const endpoint = `http://127.0.0.1:${upstream.address().port}`
const sockets = new WebSocketServer({ server: upstream })
sockets.on('connection', (socket, request) => {
  assert.match(request.headers['sec-websocket-protocol'], /hermes-gateway-ticket.fixture-ticket/)
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: true } } }))
  socket.on('message', data => {
    const frame = JSON.parse(data.toString()); let result
    if (frame.method === 'session.resume') result = { session_id: 'runtime', session_key: 'stored', resumed: 'stored', messages: [], hydrating: true, info: { profile_name: 'work' } }
    else if (frame.method === 'gateway.ping') result = {}
    else if (frame.method === 'session.events.since') { replayReads++; result = { epoch: 'process-fixture', latest_seq: events.at(-1)?.seq || 0, truncated: false, events: events.filter(event => event.seq > frame.params.last_seen), open_requests: [] } }
    else throw new Error(`Forbidden fixture observer RPC: ${frame.method}`)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
  })
})
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
if (!packagePath) await symlink(resolve('dist'), join(directory, 'dist'), 'dir')
const origin = `http://127.0.0.1:${port}`
let child
let exited
async function start() {
  child = spawn(packagePath ? join(packagePath, 'bin/agora') : process.execPath, packagePath ? [] : [resolve('server/run.ts')], {
    cwd: directory,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HERMES_ENDPOINT: endpoint, AGORA_PORT: String(port), AGORA_SESSION_DB: join(directory, 'sessions.sqlite'), AGORA_SESSION_IDLE_SECONDS: '2592000', AGORA_PUSH_VAPID_FILE: vapidFile, AGORA_FIXTURE_PUSH_RECEIVER: receiverOrigin, NODE_OPTIONS: `--import=${preload}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = once(child, 'exit')
  let output = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Session runtime did not start: ${output}`)), 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Session runtime exited before startup: ${output}`)) })
    child.stderr.on('data', data => { output += data })
    child.stdout.on('data', data => { output += data; if (output.includes('Agora: ')) { clearTimeout(timer); resolve() } })
  })
}
async function stop() {
  child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0)
}
try {
  await start()
  const beginning = await fetch(`${origin}/login`, { redirect: 'manual' })
  const loginCookie = beginning.headers.get('set-cookie').split(';')[0]
  const authorization = await fetch(beginning.headers.get('location'), { redirect: 'manual' })
  const completed = await fetch(authorization.headers.get('location'), { headers: { Cookie: loginCookie }, redirect: 'manual' })
  assert.equal(completed.status, 303)
  const cookie = completed.headers.getSetCookie().find(value => value.startsWith('agora_local_session=')).split(';')[0]
  const identity = () => fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } })
  assert.equal((await identity()).status, 200)
  const pushApi = (method = 'GET', body) => fetch(`${origin}/api/agora/push`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await pushApi('POST', { subscription })).status, 200)
  const browser = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], { headers: { Cookie: cookie, Origin: origin } })
  await once(browser, 'open')
  const snapshot = once(browser, 'message')
  browser.send(JSON.stringify({ jsonrpc: '2.0', id: 'resume', method: 'session.resume', params: { session_id: 'stored', profile: 'work', defer_history: true } }))
  await snapshot
  await until(() => replayReads > 0)
  browser.close(); await once(browser, 'close')
  events.push({ type: 'message.complete', session_id: 'runtime', seq: 1, payload: { text: 'Fictional report one is ready.', status: 'complete' } })
  await until(() => deliveries.length === 1)
  assert.equal(deliveries[0].url, '/?session=stored&profile=work')
  expire = true
  assert.equal((await identity()).status, 200)
  await stop()
  const beforeRestart = replayReads
  await start()
  await until(() => replayReads > beforeRestart)
  assert.equal(deliveries.length, 1)
  assert.equal((await (await pushApi()).json()).watched, 1)
  events.push({ type: 'message.complete', session_id: 'runtime', seq: 2, payload: { text: 'Fictional report two is ready.', status: 'complete' } })
  await until(() => deliveries.length === 2)
  assert.equal((await identity()).status, 200)
  expire = true
  assert.equal((await identity()).status, 200)
  assert.equal(generation, 3)
  const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, redirect: 'manual' })
  assert.equal(logout.status, 303)
  await stop()
  await start()
  assert.equal((await identity()).status, 401)
  await stop()
  console.info('PASS: real Node process preserves login, rotated refresh tokens, push subscription and replay cursor across restarts; encrypted delivery works with browser closed, no duplicate replay, durable logout.')
} finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await exited }
  for (const socket of sockets.clients) socket.terminate(); sockets.close()
  await new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections() })
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  await rm(directory, { recursive: true, force: true })
}
