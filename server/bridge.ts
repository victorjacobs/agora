import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { BridgeError, createAuthorization, endpointURL, NativeSession, upstreamURL } from './native-session.ts'

const SESSION_COOKIE = 'agora_local_session'
const LOGIN_COOKIE = 'agora_local_login'
const CALLBACK_PATH = '/auth/native/callback'
const LOGIN_TTL = 5 * 60_000
const MAX_BODY = 1024 * 1024

interface Login {
  state: string
  verifier: string
  expires: number
  next: string
  origin: string
}
interface BrowserSession {
  native: NativeSession
  sockets: Set<WebSocket>
  lastUsed: number
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function equal(first: string, second: string) {
  const a = Buffer.from(first)
  const b = Buffer.from(second)
  return a.length === b.length && timingSafeEqual(a, b)
}

function localOrigin(request: IncomingMessage): string {
  const host = request.headers.host
  const port = request.socket.localPort
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
    throw new BridgeError(403, 'Invalid local Host header.')
  }
  return `http://${host}`
}

function checkOrigin(request: IncomingMessage, origin: string, required = false) {
  const supplied = request.headers.origin
  if ((supplied && supplied !== origin) || (required && supplied !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new BridgeError(403, 'This request must come from the local Agora application.')
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function redirect(response: ServerResponse, destination: string, cookies: string[] = []) {
  response.writeHead(303, { Location: destination, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  response.end()
}

function browserCookie(name: string, value: string, maxAge?: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`
}

function safeNext(value: string | null) {
  if (!value || !/^\/agora\/(?:\?[^\r\n\\]*)?$/.test(value)) return '/agora/'
  return value
}

function allowedRoute(path: string, method: string) {
  if (method === 'GET' && ['/api/status', '/api/auth/providers', '/api/auth/me', '/api/agora/connection', '/api/media', '/api/media/proxy'].includes(path)) return true
  if (method === 'POST' && path === '/api/auth/ws-ticket') return true
  if (method === 'GET' && ['/api/sessions', '/api/sessions/search'].includes(path)) return true
  if (method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(path)) return true
  return ['PATCH', 'DELETE'].includes(method) && /^\/api\/sessions\/[^/]+$/.test(path)
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const parts: Buffer[] = []
  let length = 0
  for await (const part of request) {
    length += part.length
    if (length > MAX_BODY) throw new BridgeError(413, 'Request body is too large.')
    parts.push(Buffer.from(part))
  }
  return length ? Buffer.concat(parts).toString('utf8') : undefined
}

export class LocalBridge {
  readonly endpoint: URL
  private sessions = new Map<string, BrowserSession>()
  private logins = new Map<string, Login>()
  private socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  private cleanupTimer: ReturnType<typeof setInterval>
  private fetcher: typeof fetch

  constructor(endpoint: string, fetcher: typeof fetch = fetch) {
    this.endpoint = endpointURL(endpoint)
    this.fetcher = fetcher
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    this.cleanupTimer.unref()
  }

  attach(server: Server) {
    server.on('upgrade', this.upgrade)
    server.once('close', () => this.dispose())
  }

  dispose() {
    clearInterval(this.cleanupTimer)
    for (const session of this.sessions.values()) this.closeSession(session)
    this.sessions.clear()
    this.logins.clear()
    this.socketServer.close()
  }

  middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = (request.url || '').split('?')[0]
    if (!path.startsWith('/api/') && path !== '/login' && path !== '/auth/logout' && path !== CALLBACK_PATH) return next()
    void this.handle(request, response).catch(error => {
      if (!response.headersSent) json(response, error instanceof BridgeError ? error.status : 502, {
        detail: error instanceof BridgeError ? error.message : 'Unable to reach the configured Hermes server.',
      })
      else response.end()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const origin = localOrigin(request)
    const url = new URL(request.url!, origin)
    const method = request.method || 'GET'
    response.setHeader('Cache-Control', 'no-store')
    if (url.pathname === CALLBACK_PATH && method === 'GET') {
      const loginId = cookie(request, LOGIN_COOKIE)
      const pending = loginId ? this.logins.get(loginId) : undefined
      const state = url.searchParams.get('state') || ''
      const code = url.searchParams.get('code') || ''
      if (!pending || pending.expires < Date.now() || pending.origin !== origin || !equal(state, pending.state) || !code) {
        throw new BridgeError(400, 'Invalid or expired login callback. Return to Agora and start sign-in again.')
      }
      this.logins.delete(loginId!)
      const native = new NativeSession(this.endpoint, this.fetcher)
      await native.exchange(code, pending.verifier)
      const previous = cookie(request, SESSION_COOKIE)
      if (previous) this.removeSession(previous)
      const id = randomBytes(32).toString('base64url')
      this.sessions.set(id, { native, sockets: new Set(), lastUsed: Date.now() })
      return redirect(response, pending.next, [browserCookie(SESSION_COOKIE, id), browserCookie(LOGIN_COOKIE, '', 0)])
    }
    checkOrigin(request, origin, !['GET', 'HEAD'].includes(method))

    if (url.pathname === '/login' && method === 'GET') {
      this.cleanup()
      if (this.logins.size >= 100) throw new BridgeError(429, 'Too many pending sign-ins. Try again shortly.')
      const status = await new NativeSession(this.endpoint, this.fetcher).request('/api/status', {}, false)
      if (!status.ok || !(await status.json()).auth_flows?.includes('native_pkce')) {
        throw new BridgeError(502, 'This Hermes server does not advertise native_pkce login support.')
      }
      const authorization = createAuthorization(this.endpoint, `${origin.replace('localhost', '127.0.0.1')}${CALLBACK_PATH}`)
      // The callback must return to the same browser cookie host. Use the IP
      // origin throughout local mode, since Hermes requires a loopback literal.
      if (!origin.startsWith('http://127.0.0.1:')) {
        return redirect(response, `http://127.0.0.1:${request.socket.localPort}${url.pathname}${url.search}`)
      }
      const id = randomBytes(32).toString('base64url')
      const previous = cookie(request, LOGIN_COOKIE)
      if (previous) this.logins.delete(previous)
      this.logins.set(id, { state: authorization.state, verifier: authorization.verifier, origin, expires: Date.now() + LOGIN_TTL, next: safeNext(url.searchParams.get('next')) })
      return redirect(response, authorization.url.href, [browserCookie(LOGIN_COOKIE, id, LOGIN_TTL / 1000)])
    }

    if (url.pathname === '/auth/logout' && method === 'POST') {
      const id = cookie(request, SESSION_COOKIE)
      if (id) this.removeSession(id)
      const loginId = cookie(request, LOGIN_COOKIE)
      if (loginId) this.logins.delete(loginId)
      return redirect(response, '/agora/', [browserCookie(SESSION_COOKIE, '', 0), browserCookie(LOGIN_COOKIE, '', 0)])
    }
    if (!allowedRoute(url.pathname, method)) throw new BridgeError(404, 'Unsupported local API route.')
    if (url.pathname === '/api/agora/connection') {
      return json(response, 200, { mode: 'local', endpoint: this.endpoint.href.replace(/\/$/, '') })
    }
    const publicRoute = ['/api/status', '/api/auth/providers'].includes(url.pathname)
    const session = publicRoute ? undefined : this.browserSession(request)
    const native = session?.native || new NativeSession(this.endpoint, this.fetcher)
    const upstream = await native.request(url.pathname + url.search, { method, body: await readBody(request) }, !publicRoute)
    if (upstream.status >= 300 && upstream.status < 400) throw new BridgeError(502, 'Hermes unexpectedly redirected an API request.')
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
    response.end(Buffer.from(await upstream.arrayBuffer()))
  }

  private browserSession(request: IncomingMessage): BrowserSession {
    const id = cookie(request, SESSION_COOKIE)
    const session = id ? this.sessions.get(id) : undefined
    if (!session) throw new BridgeError(401, 'Sign in to your Hermes server to continue.')
    session.lastUsed = Date.now()
    return session
  }

  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url || '').split('?')[0] !== '/api/ws') return
    void this.connectSocket(request, socket, head).catch(error => {
      const status = error instanceof BridgeError ? error.status : 502
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Connection rejected\r\nConnection: close\r\n\r\n`)
    })
  }

  private async connectSocket(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = localOrigin(request)
    checkOrigin(request, origin, true)
    const session = this.browserSession(request)
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) || []
    if (!protocols.includes('hermes-gateway-v1')) throw new BridgeError(400, 'Unsupported gateway protocol.')
    const ticketResponse = await session.native.request('/api/auth/ws-ticket', { method: 'POST' })
    if (!ticketResponse.ok) throw new BridgeError(ticketResponse.status, 'Hermes rejected the WebSocket ticket.')
    const { ticket } = await ticketResponse.json()
    if (typeof ticket !== 'string' || !ticket) throw new BridgeError(502, 'Hermes returned an invalid ticket.')
    if (this.sessions.get(cookie(request, SESSION_COOKIE) || '') !== session) throw new BridgeError(401, 'This local login was cancelled.')
    const url = upstreamURL(this.endpoint, '/api/ws')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const upstream = new WebSocket(url, ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`], { handshakeTimeout: 15_000, maxPayload: MAX_BODY, followRedirects: false })
    let browser: WebSocket | undefined
    session.sockets.add(upstream)
    socket.once('close', () => upstream.terminate())
    // Attach the upstream reader before the upgrade completes so gateway.ready
    // cannot disappear between the remote handshake and the browser handshake.
    upstream.on('message', (data, binary) => { if (browser?.readyState === WebSocket.OPEN) browser.send(data, { binary }) })
    upstream.once('open', () => {
      if (socket.destroyed || !this.sessions.has(cookie(request, SESSION_COOKIE) || '')) { upstream.terminate(); socket.destroy(); return }
      this.socketServer.handleUpgrade(request, socket, head, connected => {
        browser = connected
        session.sockets.add(connected)
        connected.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }) })
        connected.on('error', () => upstream.terminate())
        connected.on('close', () => { session.sockets.delete(connected); upstream.close() })
      })
    })
    upstream.on('error', () => {
      if (browser) browser.close(1011, 'Remote connection failed')
      else if (!socket.destroyed) socket.end('HTTP/1.1 502 Connection rejected\r\nConnection: close\r\n\r\n')
    })
    upstream.on('close', code => {
      session.sockets.delete(upstream)
      if (browser?.readyState === WebSocket.OPEN) browser.close((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1011)
    })
  }

  private removeSession(id: string) {
    const session = this.sessions.get(id)
    if (session) this.closeSession(session)
    this.sessions.delete(id)
  }

  private closeSession(session: BrowserSession) {
    session.native.dispose()
    for (const socket of session.sockets) socket.terminate()
  }

  private cleanup() {
    const now = Date.now()
    for (const [id, login] of this.logins) if (login.expires < now) this.logins.delete(id)
    for (const [id, session] of this.sessions) {
      if (!session.sockets.size && session.lastUsed < now - 24 * 60 * 60_000) this.removeSession(id)
    }
  }
}
