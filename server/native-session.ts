import { createHash, randomBytes } from 'node:crypto'

export class BridgeError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
  provider: string
}

export function endpointURL(value: string): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('HERMES_ENDPOINT must be an HTTPS URL without credentials, query, or fragment (HTTP is allowed on loopback).')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url
}

export function upstreamURL(endpoint: URL, path: string): URL {
  return new URL(endpoint.href.replace(/\/$/, '') + path)
}

export function createAuthorization(endpoint: URL, redirect: string) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const url = upstreamURL(endpoint, '/auth/native/authorize')
  url.search = new URLSearchParams({
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', redirect_uri: redirect, state,
  }).toString()
  return { url, state, verifier }
}

export class NativeSession {
  private tokens?: Tokens
  private refreshPromise?: Promise<void>
  private disposed = false

  readonly endpoint: URL
  private fetcher: typeof fetch

  constructor(endpoint: URL, fetcher: typeof fetch = fetch) {
    this.endpoint = endpoint
    this.fetcher = fetcher
  }

  async exchange(code: string, verifier: string) {
    const response = await this.fetcher(upstreamURL(this.endpoint, '/auth/native/token'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new BridgeError(400, 'Hermes rejected the login code. Start sign-in again.')
    const tokens = this.parseTokens(await response.json())
    if (this.disposed) throw new BridgeError(401, 'This local login was cancelled.')
    this.tokens = tokens
  }

  async request(path: string, options: RequestInit = {}, authenticated = true): Promise<Response> {
    if (authenticated) {
      this.requireTokens()
      if (this.tokens!.expires_at <= Date.now() / 1000 + 60) await this.refresh()
    }
    let tokenUsed = ''
    const send = () => {
      tokenUsed = authenticated ? this.requireTokens().access_token : ''
      return this.fetcher(upstreamURL(this.endpoint, path), {
        ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated ? { Authorization: `Bearer ${tokenUsed}` } : {}),
        },
      })
    }
    const response = await send()
    const method = options.method || 'GET'
    // Only reads and single-use ticket minting may be retried after a definitive
    // 401. Mutations and chat frames are never replayed by the local service.
    if (authenticated && response.status === 401 && (method === 'GET' || path === '/api/auth/ws-ticket')) {
      await this.refresh(tokenUsed)
      return send()
    }
    return response
  }

  dispose() {
    this.disposed = true
    this.tokens = undefined
  }

  private requireTokens(): Tokens {
    if (!this.tokens || this.disposed) throw new BridgeError(401, 'Sign in to your Hermes server to continue.')
    return this.tokens
  }

  private async refresh(rejectedToken?: string) {
    if (rejectedToken && this.tokens?.access_token !== rejectedToken) return
    if (this.refreshPromise) return this.refreshPromise
    const tokens = this.requireTokens()
    if (!tokens.refresh_token) throw new BridgeError(401, 'Your Hermes login has expired. Sign in again.')

    this.refreshPromise = (async () => {
      const response = await this.fetcher(upstreamURL(this.endpoint, '/auth/native/refresh'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh_token, provider: tokens.provider }),
        redirect: 'manual', signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 401) { this.tokens = undefined; throw new BridgeError(401, 'Your Hermes login has expired. Sign in again.') }
      if (!response.ok) throw new BridgeError(503, 'Hermes could not refresh your login. Try again.')
      const refreshed = this.parseTokens(await response.json())
      if (this.disposed) throw new BridgeError(401, 'This local login was cancelled.')
      this.tokens = refreshed
    })()
    try { await this.refreshPromise }
    finally { this.refreshPromise = undefined }
  }

  private parseTokens(value: unknown): Tokens {
    const tokens = value as Partial<Tokens> | null
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token ||
      typeof tokens.refresh_token !== 'string' || typeof tokens.expires_at !== 'number' ||
      !Number.isFinite(tokens.expires_at) || typeof tokens.provider !== 'string') {
      throw new BridgeError(502, 'Hermes returned an incompatible native login response.')
    }
    return tokens as Tokens
  }
}
