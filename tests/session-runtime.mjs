import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'agora-session-runtime-'))
const packagePath = process.argv[2] && resolve(process.argv[2])
let challenge = ''
let generation = 1
let expire = false
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
  send({}, 404)
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const endpoint = `http://127.0.0.1:${upstream.address().port}`
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
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HERMES_ENDPOINT: endpoint, AGORA_PORT: String(port), AGORA_SESSION_DB: join(directory, 'sessions.sqlite'), AGORA_SESSION_IDLE_SECONDS: '2592000' },
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
  expire = true
  assert.equal((await identity()).status, 200)
  await stop()
  await start()
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
  console.info('PASS: real Node server preserves login and rotated refresh tokens across restarts; logout remains effective after restart.')
} finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await exited }
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  await rm(directory, { recursive: true, force: true })
}
