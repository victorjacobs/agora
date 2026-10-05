// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { LocalBridge } from '../server/bridge'

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = [] })

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return `http://127.0.0.1:${port}`
}

async function fixture() {
  let challenge = ''
  let token = 'access-1'
  let refreshes = 0
  let patches = 0
  let rejectMutation = false
  let rejectRefresh = false
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
      return send({ access_token: token, refresh_token: 'refresh-1', provider: 'self-hosted', expires_at: Date.now() / 1000 + 3600 })
    }
    if (url.pathname === '/auth/native/refresh') {
      refreshes++
      expect((await body()).refresh_token).toBe('refresh-1')
      if (rejectRefresh) return send({}, 401)
      token = 'access-2'
      return send({ access_token: token, refresh_token: 'refresh-1', provider: 'self-hosted', expires_at: Date.now() / 1000 + 3600 })
    }
    if (request.headers.authorization !== `Bearer ${token}`) return send({ detail: 'Unauthorized' }, 401)
    if (['/api/media', '/api/media/proxy'].includes(url.pathname)) return send({ data_url: 'data:image/png;base64,aGVsbG8=' })
    if (url.pathname === '/api/sessions/search') return send({ results: [{ id: 'old', title: 'Older chat' }] })
    if (url.pathname === '/api/auth/me') return send({ display_name: 'Synthetic operator' })
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
  const bridge = new LocalBridge(upstreamOrigin)
  const localServer = createServer((request, response) => bridge.middleware(request, response, () => { response.writeHead(404); response.end() }))
  bridge.attach(localServer)
  const origin = await listen(localServer)
  cleanup.push(() => bridge.dispose())
  const beginLogin = async (next = '/agora/?session=test') => {
    const beginning = await fetch(`${origin}/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' })
    const loginCookie = beginning.headers.get('set-cookie')!.split(';')[0]
    const authorize = await fetch(beginning.headers.get('location')!, { redirect: 'manual' })
    const callback = authorize.headers.get('location')!
    return { loginCookie, callback }
  }
  const login = async (next = '/agora/?session=test') => {
    const { loginCookie, callback } = await beginLogin(next)
    const completed = await fetch(callback, { headers: { Cookie: loginCookie }, redirect: 'manual' })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe(next.startsWith('/agora/') ? next : '/agora/')
    const cookie = completed.headers.getSetCookie().find(value => value.startsWith('agora_local_session='))!.split(';')[0]
    return { cookie, callback, loginCookie }
  }
  return {
    origin, login, beginLogin, records, bridge,
    expire: () => { refreshedExpiry = true }, rejectRefresh: () => { rejectRefresh = true; refreshedExpiry = true },
    rejectMutation: () => { rejectMutation = true },
    counts: () => ({ refreshes, patches }),
  }
}

describe('local remote-Hermes connection', () => {
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

  it('proxies media reads with server-held grants and requires a browser session', async () => {
    const test = await fixture()
    expect((await fetch(`${test.origin}/api/media?path=/images/cat.png`)).status).toBe(401)
    const { cookie } = await test.login()
    for (const route of ['/api/media?path=/images/cat.png', '/api/media/proxy?url=https%3A%2F%2Ffal.media%2Fcat.png']) {
      const response = await fetch(`${test.origin}${route}`, { headers: { Cookie: cookie } })
      expect(await response.json()).toEqual({ data_url: 'data:image/png;base64,aGVsbG8=' })
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
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
    const completed = await fetch(callback, { headers: { Cookie: loginCookie }, redirect: 'manual' })
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
    await test.login('//untrusted.test')
    expect(() => new LocalBridge('http://hermes.example')).toThrow(/HTTPS/)
    expect(() => new LocalBridge('https://user:password@hermes.example')).toThrow(/credentials/)
  })
})
