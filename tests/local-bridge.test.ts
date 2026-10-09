// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { HermesBridge, publicOriginURL } from '../server/bridge'

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; vi.restoreAllMocks() })

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return `http://127.0.0.1:${port}`
}

function sessionDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'agora-session-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'sessions.sqlite')
}

async function fixture(publicOrigin?: string, options: { sessionDb?: string; sessionIdleSeconds?: number } = {}) {
  let challenge = ''
  let token = 'access-1'
  let refreshToken = 'refresh-1'
  let refreshes = 0
  let patches = 0
  let rejectMutation = false
  let rejectRefresh = false
  let transientRefreshFailure = false
  let pauseIdentity: (() => Promise<void>) | undefined
  let pauseRefresh: (() => Promise<void>) | undefined
  let refreshedExpiry = false
  const records: Array<{ path: string; authorization?: string; cookie?: string }> = []
  const upstreamServer = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://upstream.test')
    records.push({ path: url.pathname, authorization: request.headers.authorization, cookie: request.headers.cookie })
    response.setHeader('Content-Type', 'application/json')
    const send = (body: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(body)) }
    const body = async () => {
      const parts = []
      for await (const part of request) parts.push(part)
      return JSON.parse(Buffer.concat(parts).toString())
    }
    if (url.pathname === '/api/status') return send({ auth_required: true, auth_flows: ['cookie', 'native_pkce'] })
    if (url.pathname === '/auth/native/authorize') {
      challenge = url.searchParams.get('code_challenge')!
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! }).toString()
      response.writeHead(302, { Location: callback.href }); response.end(); return
    }
    if (url.pathname === '/auth/native/token') {
      const value = await body()
      if (value.code !== 'synthetic-code' || createHash('sha256').update(value.code_verifier).digest('base64url') !== challenge) return send({}, 400)
      return send({ access_token: token, refresh_token: refreshToken, provider: 'self-hosted', expires_at: Date.now() / 1000 + 3600 })
    }
    if (url.pathname === '/auth/native/refresh') {
      refreshes++
      expect((await body()).refresh_token).toBe(refreshToken)
      if (pauseRefresh) await pauseRefresh()
      if (rejectRefresh) return send({}, 401)
      if (transientRefreshFailure) { transientRefreshFailure = false; return send({}, 503) }
      token = `access-${refreshes + 1}`
      refreshToken = `refresh-${refreshes + 1}`
      return send({ access_token: token, refresh_token: refreshToken, provider: 'self-hosted', expires_at: Date.now() / 1000 + 3600 })
    }
    if (request.headers.authorization !== `Bearer ${token}`) return send({ detail: 'Unauthorized' }, 401)
    if (url.pathname.startsWith('/api/cron/jobs')) return send({ ok: true, method: request.method })
    if (url.pathname === '/api/learning/node' && ['PUT', 'DELETE'].includes(request.method || '')) return send({ ok: true, value: await body() })
    if (['/api/profiles/active', '/api/memory', '/api/learning/graph', '/api/learning/node'].includes(url.pathname)) return send({ inspected: true })
    if (url.pathname === '/api/fs/read-data-url') return send({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
    if (url.pathname === '/api/fs/download') {
      if (url.searchParams.get('path') !== '/workspace/report.pdf') return send({ detail: 'File not found' }, 404)
      expect(url.searchParams.get('profile')).toBe('work')
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="report.pdf"' })
      response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]))
      return
    }
    if (['/api/media', '/api/media/proxy'].includes(url.pathname)) return send({ data_url: 'data:image/png;base64,aGVsbG8=' })
    if (url.pathname === '/api/sessions/test' && request.method === 'GET') return send({ id: 'test', title: 'Pinned chat', profile: url.searchParams.get('profile') })
    if (url.pathname === '/api/sessions/search') return send({ results: [{ id: 'old', title: 'Older chat' }] })
    if (url.pathname === '/api/auth/me') {
      if (pauseIdentity) await pauseIdentity()
      return send({ display_name: 'Synthetic operator' })
    }
    if (url.pathname === '/api/auth/ws-ticket') return send({ ticket: 'synthetic-ticket', ttl_seconds: 30 })
    if (url.pathname === '/api/sessions/test' && request.method === 'PATCH') {
      patches++
      if (rejectMutation) return send({ detail: 'Unauthorized' }, 401)
      return send({ title: (await body()).title })
    }
    if (url.pathname === '/api/sessions') {
      if (refreshedExpiry) { refreshedExpiry = false; token = 'access-2'; return send({}, 401) }
      return send({ sessions: [{ id: 'test' }], total: 1 })
    }
    send({ detail: 'Not found' }, 404)
  })
  const upstreamOrigin = await listen(upstreamServer)
  const upstreamSockets = new WebSocketServer({ server: upstreamServer })
  cleanup.push(() => { for (const socket of upstreamSockets.clients) socket.terminate(); upstreamSockets.close() })
  upstreamSockets.on('connection', (socket, request) => {
    expect(request.headers.origin).toBeUndefined()
    expect(request.headers['sec-websocket-protocol']).toContain('hermes-gateway-ticket.synthetic-ticket')
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
    socket.on('message', data => socket.send(data))
  })
  let bridge = new HermesBridge(upstreamOrigin, fetch, { publicOrigin, ...options })
  const localServer = createServer((request, response) => bridge.middleware(request, response, () => { response.writeHead(404); response.end() }))
  bridge.attach(localServer)
  const origin = await listen(localServer)
  cleanup.push(() => bridge.dispose())
  const request = (path: string, options: RequestInit = {}): Promise<Response> => {
    if (!publicOrigin) return fetch(`${origin}${path}`, options)
    return new Promise((resolve, reject) => {
      const headers = new Headers(options.headers)
      if (!headers.has('Host')) headers.set('Host', new URL(publicOrigin).host)
      const outgoing = httpRequest(`${origin}${path}`, {
        method: options.method, headers: Object.fromEntries(headers),
      }, response => {
        const parts: Buffer[] = []
        response.on('data', part => parts.push(part))
        response.on('error', reject)
        response.on('end', () => {
          const headers = new Headers()
          for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!)
          resolve(new Response(Buffer.concat(parts), { status: response.statusCode, headers }))
        })
      })
      outgoing.on('error', reject)
      if (typeof options.body === 'string') outgoing.write(options.body)
      outgoing.end()
    })
  }
  const beginLogin = async (next = '/?session=test') => {
    const beginning = await request(`/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' })
    const loginCookie = beginning.headers.get('set-cookie')!.split(';')[0]
    const authorize = await fetch(beginning.headers.get('location')!, { redirect: 'manual' })
    const callback = authorize.headers.get('location')!
    return { loginCookie, callback }
  }
  const login = async (next = '/?session=test', expectedNext = next) => {
    const { loginCookie, callback } = await beginLogin(next)
    const target = new URL(callback)
    const completed = await request(target.pathname + target.search, { headers: { Cookie: loginCookie, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe(expectedNext)
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith(publicOrigin ? '__Host-agora_session=' : 'agora_local_session='))!.split(';')[0]
    return { cookie, callback, loginCookie, completed }
  }
  return {
    origin, login, beginLogin, records, get bridge() { return bridge }, request, publicOrigin,
    pause: (route: 'identity' | 'refresh') => {
      let release!: () => void
      let notify!: () => void
      const waiting = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { notify = resolve })
      const wait = () => { notify(); return waiting }
      if (route === 'identity') pauseIdentity = wait
      else pauseRefresh = wait
      return { started, release }
    },
    restart: (endpoint = upstreamOrigin) => {
      bridge.dispose()
      bridge = new HermesBridge(endpoint, fetch, { publicOrigin, ...options })
      bridge.attach(localServer)
    },
    expire: () => { refreshedExpiry = true }, rejectRefresh: () => { rejectRefresh = true; refreshedExpiry = true },
    failRefreshOnce: () => { transientRefreshFailure = true; refreshedExpiry = true },
    rejectMutation: () => { rejectMutation = true },
    counts: () => ({ refreshes, patches }),
  }
}

describe('local remote-Hermes connection', () => {
  it('restores a login from SQLite after restarting the bridge', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.restart()
    const response = await test.request('/api/auth/me', { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ display_name: 'Synthetic operator' })
    expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
  })

  it('issues a persistent secure cookie and renews it on authenticated activity', async () => {
    const test = await fixture('https://agora.example.test', { sessionDb: sessionDatabase(), sessionIdleSeconds: 120 })
    const { cookie, completed } = await test.login()
    const sessionCookie = completed.headers.getSetCookie().find(value => value.startsWith('__Host-agora_session='))!
    expect(sessionCookie).toContain('Max-Age=120')
    expect(sessionCookie).toContain('HttpOnly; SameSite=Lax; Secure')
    const response = await test.request('/api/auth/me', { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBe(sessionCookie)
  })

  it('persists rolling activity but rejects an idle session before the cleanup timer runs', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const test = await fixture(undefined, { sessionDb: sessionDatabase(), sessionIdleSeconds: 10 })
    const { cookie } = await test.login()
    now += 8000
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    test.restart()
    now += 8000
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    now += 11_000
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('persists rotated refresh tokens before a restart and refreshes them again', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.expire()
    expect((await test.request('/api/sessions', { headers: { Cookie: cookie } })).status).toBe(200)
    test.restart()
    test.expire()
    expect((await test.request('/api/sessions', { headers: { Cookie: cookie } })).status).toBe(200)
    expect(test.counts().refreshes).toBe(2)
    expect(test.records.at(-1)?.authorization).toBe('Bearer access-3')
  })

  it('deletes logged-out sessions from disk so a restart cannot restore them', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    const logout = await test.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: test.origin }, redirect: 'manual' })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('deletes a persisted session when Hermes definitively rejects refresh', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.rejectRefresh()
    expect((await test.request('/api/sessions', { headers: { Cookie: cookie } })).status).toBe(401)
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
    expect(test.counts().refreshes).toBe(1)
  })

  it('does not reuse persisted credentials for a different Hermes endpoint', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.restart(`${test.bridge.endpoint.href}different-endpoint`)
    const before = test.records.length
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
    expect(test.records).toHaveLength(before)
  })

  it('supports opting out of persistent storage', async () => {
    const test = await fixture(undefined, { sessionDb: ':memory:' })
    const { cookie } = await test.login()
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('refreshes an expired persisted access token before using it', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.restart()
    now += 3_660_000
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    expect(test.counts().refreshes).toBe(1)
    expect(test.records.at(-1)?.authorization).toBe('Bearer access-2')
  })

  it('retains persisted credentials after a transient refresh failure', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    test.failRefreshOnce()
    expect((await test.request('/api/sessions', { headers: { Cookie: cookie } })).status).toBe(503)
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    expect(test.counts().refreshes).toBe(2)
  })

  it('does not reinstate a cookie from an HTTP response arriving after logout', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    const pause = test.pause('identity')
    const pending = test.request('/api/auth/me', { headers: { Cookie: cookie } })
    await pause.started
    try {
      expect((await test.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: test.origin }, redirect: 'manual' })).status).toBe(303)
    } finally { pause.release() }
    expect((await pending).headers.get('set-cookie')).toBeNull()
  })

  it('does not recreate a persisted session from a refresh arriving after logout', async () => {
    const test = await fixture(undefined, { sessionDb: sessionDatabase() })
    const { cookie } = await test.login()
    const pause = test.pause('refresh')
    test.expire()
    const pending = test.request('/api/sessions', { headers: { Cookie: cookie } })
    await pause.started
    try {
      expect((await test.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: test.origin }, redirect: 'manual' })).status).toBe(303)
    } finally { pause.release() }
    expect((await pending).status).toBe(401)
    test.restart()
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('forwards authenticated pinned-session metadata requests', async () => {
    const test = await fixture()
    const { cookie } = await test.login()
    const response = await fetch(`${test.origin}/api/sessions/test?profile=work`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'test', title: 'Pinned chat', profile: 'work' })
    expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
  })

  it('forwards authenticated cron operations and blocks foreign origins and unrelated cron routes', async () => {
    const test = await fixture()
    const { cookie } = await test.login()
    for (const [path, method] of [['/api/cron/jobs', 'GET'], ['/api/cron/jobs', 'POST'], ['/api/cron/jobs/job', 'PUT'], ['/api/cron/jobs/job', 'DELETE'], ['/api/cron/jobs/job/runs', 'GET'], ['/api/cron/jobs/job/pause', 'POST'], ['/api/cron/jobs/job/resume', 'POST'], ['/api/cron/jobs/job/trigger', 'POST']]) {
      const response = await fetch(`${test.origin}${path}?profile=work`, { method, headers: { Cookie: cookie, Origin: test.origin } })
      expect(response.status).toBe(200)
      expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
    }
    const before = test.records.length
    expect((await fetch(`${test.origin}/api/cron/jobs/job/trigger`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://foreign.test' } })).ok).toBe(false)
    expect((await fetch(`${test.origin}/api/cron/fire/job`, { method: 'POST', headers: { Cookie: cookie, Origin: test.origin } })).ok).toBe(false)
    expect(test.records).toHaveLength(before)
  })

  it('forwards authenticated memory inspection and rejects unsupported writes', async () => {
    const test = await fixture()
    const { cookie } = await test.login()
    for (const path of ['/api/profiles/active', '/api/memory?profile=work', '/api/learning/graph?profile=work', '/api/learning/node?id=memory%3Amemory%3A0%3Aabc&profile=work']) {
      const response = await fetch(`${test.origin}${path}`, { headers: { Cookie: cookie } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ inspected: true })
      expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
    }
    for (const method of ['POST', 'PATCH']) {
      const before = test.records.length
      const response = await fetch(`${test.origin}/api/learning/node`, { method, headers: { Cookie: cookie, Origin: test.origin } })
      expect(response.ok).toBe(false)
      expect(test.records).toHaveLength(before)
    }
  })

  it('requires authentication and a local origin for memory writes and forwards exact bodies', async () => {
    const test = await fixture()
    for (const method of ['PUT', 'DELETE']) {
      expect((await fetch(`${test.origin}/api/learning/node`, { method, headers: { Origin: test.origin } })).status).toBe(401)
    }
    const { cookie } = await test.login()
    for (const method of ['PUT', 'DELETE']) {
      const before = test.records.length
      const value = { id: 'memory:memory:0:abc', profile: 'work', ...(method === 'PUT' ? { content: 'Updated note' } : {}) }
      const body = JSON.stringify(value)
      const foreign = await fetch(`${test.origin}/api/learning/node`, { method, headers: { Cookie: cookie, Origin: 'https://foreign.test', 'Content-Type': 'application/json' }, body })
      expect(foreign.ok).toBe(false)
      expect(test.records).toHaveLength(before)
      const response = await fetch(`${test.origin}/api/learning/node`, { method, headers: { Cookie: cookie, Origin: test.origin, 'Content-Type': 'application/json' }, body })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, value })
      expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
    }
  })

  it('returns login to the root conversation URL and rejects unsafe return paths', async () => {
    const test = await fixture()
    await test.login('/?session=a%20b&profile=work')
    await test.login('/')
    for (const next of ['//untrusted.test', '/\\untrusted.test', 'https://untrusted.test', '/auth/logout', '/agora/', '/?session=x\nLocation: https://untrusted.test']) {
      await test.login(next, '/')
    }
  })

  it('completes PKCE, forwards bearer REST, and never publishes tokens to the browser', async () => {
    const test = await fixture()
    expect((await fetch(`${test.origin}/api/auth/me`)).status).toBe(401)
    const { cookie } = await test.login()
    expect(cookie).not.toContain('access-1')
    const identity = await fetch(`${test.origin}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(await identity.json()).toEqual({ display_name: 'Synthetic operator' })
    expect(test.records.findLast(record => record.path === '/api/auth/me')?.authorization).toBe('Bearer access-1')
    expect(test.records.findLast(record => record.path === '/api/auth/me')?.cookie).toBeUndefined()
    const config = await fetch(`${test.origin}/api/agora/connection`)
    expect((await config.json()).mode).toBe('local')
  })

  it('requires authentication for conversation search and forwards it as a read-only route', async () => {
    const test = await fixture()
    expect((await fetch(`${test.origin}/api/sessions/search?q=logs`)).status).toBe(401)
    const { cookie } = await test.login()
    const response = await fetch(`${test.origin}/api/sessions/search?q=logs&exclude_sources=cron`, { headers: { Cookie: cookie } })
    expect(await response.json()).toEqual({ results: [{ id: 'old', title: 'Older chat' }] })
    expect(test.records.findLast(record => record.path === '/api/sessions/search')?.authorization).toBe('Bearer access-1')
    expect((await fetch(`${test.origin}/api/sessions/search`, { method: 'POST', headers: { Cookie: cookie, Origin: test.origin } })).status).toBe(404)
  })

  it.each([undefined, 'https://agora.example.test'])('delivers generated files with authenticated binary downloads (%s)', async publicOrigin => {
    const test = await fixture(publicOrigin)
    const route = '/api/fs/download?path=%2Fworkspace%2Freport.pdf&profile=work'
    expect((await test.request(route)).status).toBe(401)
    const { cookie } = await test.login()
    const response = await test.request(route, { headers: { Cookie: cookie } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"')
    expect(response.headers.get('set-cookie')).toContain(`${cookie};`)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=2592000')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]))
    expect(test.records.at(-1)?.authorization).toBe('Bearer access-1')
    expect(test.records.at(-1)?.cookie).toBeUndefined()
    expect((await test.request(route, { method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin || test.origin } })).status).toBe(404)
    const missing = await test.request('/api/fs/download?path=%2Fworkspace%2Fmissing.pdf&profile=work', { headers: { Cookie: cookie } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-disposition')).toBeNull()
    expect(await missing.json()).toEqual({ detail: 'File not found' })
  })

  it('proxies media reads with server-held grants and requires a browser session', async () => {
    const test = await fixture()
    expect((await fetch(`${test.origin}/api/media?path=/images/cat.png`)).status).toBe(401)
    const { cookie } = await test.login()
    for (const route of ['/api/media?path=/images/cat.png', '/api/media/proxy?url=https%3A%2F%2Ffal.media%2Fcat.png']) {
      const response = await fetch(`${test.origin}${route}`, { headers: { Cookie: cookie } })
      expect(await response.json()).toEqual({ data_url: 'data:image/png;base64,aGVsbG8=' })
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const workspaceImage = await fetch(`${test.origin}/api/fs/read-data-url?path=/workspace/chart.png&profile=work`, { headers: { Cookie: cookie } })
    expect(await workspaceImage.json()).toEqual({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
    expect(test.records.findLast(record => record.path === '/api/fs/read-data-url')?.authorization).toBe('Bearer access-1')
    expect(test.records.findLast(record => record.path === '/api/media')?.authorization).toBe('Bearer access-1')
    expect(test.records.findLast(record => record.path === '/api/media/proxy')?.cookie).toBeUndefined()
    expect((await fetch(`${test.origin}/api/media`, { method: 'POST', headers: { Cookie: cookie, Origin: test.origin } })).status).toBe(404)
  })

  it('rejects callbacks with incorrect state, missing browser binding, or replayed codes', async () => {
    const test = await fixture()
    const { callback, loginCookie } = await test.beginLogin()
    const altered = new URL(callback)
    altered.searchParams.set('state', 'wrong-state')
    expect((await fetch(altered, { headers: { Cookie: loginCookie } })).status).toBe(400)
    expect((await fetch(callback)).status).toBe(400)
    const target = new URL(callback)
    const completed = await test.request(target.pathname + target.search, { headers: { Cookie: loginCookie, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' })
    expect(completed.status).toBe(303)
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith('agora_local_session='))!.split(';')[0]
    expect((await fetch(callback, { headers: { Cookie: loginCookie } })).status).toBe(400)
    expect((await fetch(`${test.origin}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('refreshes once for concurrent rejected reads and never replays a mutation', async () => {
    const test = await fixture()
    const { cookie } = await test.login()
    test.expire()
    const headers = { Cookie: cookie }
    const responses = await Promise.all([fetch(`${test.origin}/api/sessions`, { headers }), fetch(`${test.origin}/api/sessions`, { headers })])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(test.counts().refreshes).toBe(1)
    test.rejectMutation()
    const mutation = await fetch(`${test.origin}/api/sessions/test`, { method: 'PATCH', headers: { ...headers, Origin: test.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Synthetic title' }) })
    expect(mutation.status).toBe(401)
    expect(test.counts().patches).toBe(1)
  })

  it('reports expired native grants and keeps browser sessions separate', async () => {
    const test = await fixture()
    const first = await test.login()
    const second = await test.login()
    const logout = await fetch(`${test.origin}/auth/logout`, { method: 'POST', headers: { Cookie: first.cookie, Origin: test.origin }, redirect: 'manual' })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe('/')
    expect((await fetch(`${test.origin}/api/auth/me`, { headers: { Cookie: first.cookie } })).status).toBe(401)
    expect((await fetch(`${test.origin}/api/auth/me`, { headers: { Cookie: second.cookie } })).status).toBe(200)
    test.rejectRefresh()
    expect((await fetch(`${test.origin}/api/sessions`, { headers: { Cookie: second.cookie } })).status).toBe(401)
  })

  it('preserves gateway.ready, forwards frames, and renews tickets without a browser Origin upstream', async () => {
    const test = await fixture()
    const { cookie } = await test.login()
    const socket = new WebSocket(test.origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], { headers: { Cookie: cookie, Origin: test.origin } })
    cleanup.push(() => socket.terminate())
    const [ready] = await once(socket, 'message')
    expect(JSON.parse(ready.toString()).params.type).toBe('gateway.ready')
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'gateway.ping' }))
    const [reply] = await once(socket, 'message')
    expect(JSON.parse(reply.toString()).id).toBe('test')
    const firstClosed = once(socket, 'close')
    socket.close()
    await firstClosed
    const reconnected = new WebSocket(test.origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], { headers: { Cookie: cookie, Origin: test.origin } })
    cleanup.push(() => reconnected.terminate())
    await once(reconnected, 'message')
    expect(test.records.filter(record => record.path === '/api/auth/ws-ticket')).toHaveLength(2)
    const closed = once(reconnected, 'close')
    await fetch(`${test.origin}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: test.origin }, redirect: 'manual' })
    await closed
  })

  it('blocks cross-origin local access, unsafe returns, arbitrary forwarding, and remote cleartext endpoints', async () => {
    const test = await fixture()
    expect((await fetch(`${test.origin}/api/status`, { headers: { Origin: 'https://untrusted.test' } })).status).toBe(403)
    expect((await fetch(`${test.origin}/auth/logout`, { method: 'POST' })).status).toBe(403)
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${test.origin}/api/status`, { headers: { Host: 'attacker.test' } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
      request.end()
    })
    expect(invalidHostStatus).toBe(403)
    expect((await fetch(`${test.origin}/api/config`)).status).toBe(404)
    await test.login('//untrusted.test', '/')
    expect(() => new HermesBridge('http://hermes.example')).toThrow(/HTTPS/)
    expect(() => new HermesBridge('https://user:password@hermes.example')).toThrow(/credentials/)
  })
})


describe('hosted Hermes bridge', () => {
  const publicOrigin = 'https://agora.example.com'

  it('uses the configured HTTPS callback and host-only secure cookies behind a proxy', async () => {
    const test = await fixture(publicOrigin)
    const { loginCookie, callback } = await test.beginLogin()
    expect(loginCookie).toMatch(/^__Host-agora_login=/)
    expect(new URL(callback).origin + new URL(callback).pathname).toBe(publicOrigin + '/auth/native/callback')
    const target = new URL(callback)
    expect((await test.request(target.pathname + target.search)).status).toBe(400)
    const altered = new URL(target)
    altered.searchParams.set('state', 'wrong-state')
    expect((await test.request(altered.pathname + altered.search, { headers: { Cookie: loginCookie } })).status).toBe(400)
    const completed = await test.request(target.pathname + target.search, {
      headers: { Cookie: loginCookie, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual',
    })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe('/?session=test')
    const cookies = completed.headers.getSetCookie()
    for (const cookie of cookies) {
      expect(cookie).toContain('; Secure')
      expect(cookie).toContain('; HttpOnly')
      expect(cookie).toContain('; SameSite=Lax')
      expect(cookie).toContain('; Path=/')
      expect(cookie).not.toContain('Domain=')
      expect(cookie).not.toContain('access-1')
      expect(cookie).not.toContain('refresh-1')
    }
    const cookie = cookies.find(value => value.startsWith('__Host-agora_session='))!.split(';')[0]
    expect((await test.request('/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200)
    expect(test.records.findLast(record => record.path === '/api/auth/me')?.authorization).toBe('Bearer access-1')
    expect(test.records.findLast(record => record.path === '/api/auth/me')?.cookie).toBeUndefined()
    expect((await (await test.request('/api/agora/connection')).json()).mode).toBe('hosted')
    expect((await test.request(target.pathname + target.search, { headers: { Cookie: loginCookie } })).status).toBe(400)
  })

  it('rejects foreign Hosts and Origins and ignores spoofed forwarding headers', async () => {
    const test = await fixture(publicOrigin)
    const before = test.records.length
    for (const path of ['/api/status', '/', '/assets/app.js']) {
      expect((await test.request(path, { headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'agora.example.com', 'X-Forwarded-Proto': 'https' } })).status).toBe(403)
    }
    expect(test.records).toHaveLength(before)
    const { cookie } = await test.login()
    for (const origin of [undefined, 'https://foreign.example', 'http://agora.example.com']) {
      expect((await test.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } })).status).toBe(403)
    }
    const started = await test.request('/login', {
      headers: { 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http' }, redirect: 'manual',
    })
    expect(new URL(started.headers.get('location')!).searchParams.get('redirect_uri')).toBe(publicOrigin + '/auth/native/callback')
    expect(started.headers.get('set-cookie')).toContain('; Secure')
    expect((await test.request('/auth/unsupported')).status).toBe(404)
  })

  it('keeps sessions isolated, refreshes tokens, and clears secure cookies on logout', async () => {
    const test = await fixture(publicOrigin)
    const first = await test.login()
    const second = await test.login()
    test.expire()
    expect((await test.request('/api/sessions', { headers: { Cookie: second.cookie } })).status).toBe(200)
    expect(test.counts().refreshes).toBe(1)
    const logout = await test.request('/auth/logout', {
      method: 'POST', headers: { Cookie: first.cookie, Origin: publicOrigin }, redirect: 'manual',
    })
    expect(logout.status).toBe(303)
    expect(logout.headers.getSetCookie().every(cookie => cookie.includes('; Secure') && cookie.includes('Max-Age=0'))).toBe(true)
    expect((await test.request('/api/auth/me', { headers: { Cookie: first.cookie } })).status).toBe(401)
    expect((await test.request('/api/auth/me', { headers: { Cookie: second.cookie } })).status).toBe(200)
    test.bridge.dispose()
    expect((await test.request('/api/auth/me', { headers: { Cookie: second.cookie } })).status).toBe(401)
  })

  it('requires the public browser Origin for WebSockets while connecting upstream as a native client', async () => {
    const test = await fixture(publicOrigin)
    const { cookie } = await test.login()
    const headers = { Cookie: cookie, Host: 'agora.example.com', Origin: publicOrigin }
    const socket = new WebSocket(test.origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], { headers })
    cleanup.push(() => socket.terminate())
    const [ready] = await once(socket, 'message')
    expect(JSON.parse(ready.toString()).params.type).toBe('gateway.ready')
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'hosted', method: 'gateway.ping' }))
    const [reply] = await once(socket, 'message')
    expect(JSON.parse(reply.toString()).id).toBe('hosted')
    const before = test.records.length
    const foreign = new WebSocket(test.origin.replace('http:', 'ws:') + '/api/ws', ['hermes-gateway-v1'], {
      headers: { ...headers, Origin: 'https://foreign.example' },
    })
    cleanup.push(() => foreign.terminate())
    foreign.on('error', () => {})
    const [, response] = await once(foreign, 'unexpected-response')
    expect(response.statusCode).toBe(403)
    foreign.terminate()
    expect(test.records).toHaveLength(before)
    const closed = once(socket, 'close')
    await test.request('/auth/logout', { method: 'POST', headers, redirect: 'manual' })
    await closed
  })

  it('accepts only a canonical public HTTPS origin', () => {
    expect(publicOriginURL(publicOrigin + '/').origin).toBe(publicOrigin)
    for (const origin of ['http://agora.example', 'https://user:password@agora.example', 'https://agora.example/path', 'https://agora.example?x=1', 'https://agora.example#', 'https://agora.example\n', 'https://AGORA.example', 'https://agora.example:443']) {
      expect(() => publicOriginURL(origin)).toThrow()
    }
  })
})
