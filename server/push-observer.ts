import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { ConnectionLost, Gateway, type Socket } from '../src/hermes/gateway.ts'
import type { GatewayEvent, ServerRequest } from '../src/hermes/types.ts'
import { BridgeError, NativeSession, upstreamURL } from './native-session.ts'
import type { PushWatch, SessionStore } from './session-store.ts'
import { notificationPayload, sendPush, type PushConfig } from './push.ts'

interface Replay { epoch: string; latest_seq: number; truncated: boolean; events: GatewayEvent[]; open_requests: ServerRequest[] }
interface Notice { kind: string; text?: unknown }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function replayNotifications(watch: PushWatch, replay: Replay): Notice[] {
  if (typeof replay.epoch !== 'string' || !Number.isSafeInteger(replay.latest_seq) || !Array.isArray(replay.events) || !Array.isArray(replay.open_requests)) throw new Error('Unsupported event replay.')
  const baseline = !watch.epoch || watch.epoch !== replay.epoch || replay.truncated
  const notices: Notice[] = []
  const remember = (id: string) => {
    const key = digest(`${replay.epoch}:${watch.runtime}:${id}`)
    if (watch.seen.includes(key)) return false
    watch.seen.push(key)
    return true
  }
  for (const event of replay.events) {
    if (event.session_id !== watch.runtime || !Number.isSafeInteger(event.seq) || event.seq! <= watch.seq) continue
    const payload = event.payload || {}
    if (!baseline && event.type === 'message.complete' && !payload.error && (!payload.status || payload.status === 'complete') && remember(`reply:${event.seq}`)) notices.push({ kind: 'reply', text: payload.text })
  }
  for (const request of replay.open_requests) {
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') continue
    const sid = request.params?.session_id || request.params?.gateway_session_id
    if (sid && sid !== watch.runtime) continue
    if (remember(`request:${request.id}`) && !baseline && ['clarify', 'approval', 'sudo', 'vault.save_login', 'vault.unlock_prompt', 'vault.code', 'secret'].includes(request.method)) {
      notices.push({ kind: request.method, text: request.method === 'clarify' ? request.params?.questions?.[0]?.question : undefined })
    }
  }
  watch.epoch = replay.epoch
  watch.seq = replay.latest_seq
  watch.seen = watch.seen.slice(-512)
  return notices
}

// Hermes accounts 4 MiB of compact UTF-8 events before seq stamping. Allow up to
// 3x for JSON whitespace/ASCII escaping, 64 KiB for 512 seq fields + RPC envelope,
// and 4 MiB of serialized open_requests (upstream does not bound that collection).
const MAX_REPLAY_WIRE_BYTES = 3 * 4 * 1024 * 1024 + 64 * 1024 + 4 * 1024 * 1024

export class PushObserver {
  private gateway = new Gateway((url, protocols) => new WebSocket(url, protocols, { followRedirects: false, handshakeTimeout: 15_000, maxPayload: MAX_REPLAY_WIRE_BYTES }) as unknown as Socket)
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private connected = false
  private failures = 0
  private lastAuthCheck = 0
  private deliveryUnavailable = false
  private lastWatch = ''
  private watchFailures = new Map<string, { count: number; retryAt: number }>()
  status = 'connecting'

  private owner: string
  private native: NativeSession
  private store: SessionStore
  private config: PushConfig
  private valid: () => boolean
  private revoke: () => void

  constructor(owner: string, native: NativeSession, store: SessionStore, config: PushConfig, valid: () => boolean, revoke: () => void) {
    this.owner = owner; this.native = native; this.store = store; this.config = config; this.valid = valid; this.revoke = revoke
    this.gateway.onDisconnect = () => { this.connected = false; this.status = 'reconnecting' }
    this.timer = setTimeout(() => void this.tick(), 0)
    this.timer.unref()
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.gateway.close(); this.status = 'off' }

  private async tick() {
    try {
      if (!this.valid() || !this.store.subscriptions(this.owner).length) { this.stop(); return }
      if (Date.now() - this.lastAuthCheck >= 30_000) {
        const identity = await this.native.request('/api/auth/me')
        if (identity.status === 401) throw new BridgeError(401, 'Login expired.')
        if (!identity.ok) throw new Error('Authentication unavailable.')
        this.lastAuthCheck = Date.now()
      }
      if (!this.connected) {
        const response = await this.native.request('/api/auth/ws-ticket', { method: 'POST' })
        if (response.status === 401) throw new BridgeError(401, 'Login expired.')
        if (!response.ok) throw new Error('Ticket unavailable.')
        const { ticket } = await response.json()
        if (typeof ticket !== 'string' || !ticket) throw new Error('Unsupported ticket.')
        const url = upstreamURL(this.native.endpoint, '/api/ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        if (this.stopped || !this.valid()) return
        await this.gateway.connect(url.href, ticket)
        this.connected = true
      }
      const watches = this.store.watches(this.owner).sort((a, b) => a.runtime.localeCompare(b.runtime))
      const runtimes = new Set(watches.map(watch => watch.runtime))
      for (const runtime of this.watchFailures.keys()) if (!runtimes.has(runtime)) this.watchFailures.delete(runtime)
      const start = (watches.findIndex(watch => watch.runtime === this.lastWatch) + 1) % (watches.length || 1)
      for (let offset = 0; offset < watches.length; offset++) {
        const watch = watches[(start + offset) % watches.length]!
        if (this.stopped || !this.valid()) return
        if ((this.watchFailures.get(watch.runtime)?.retryAt || 0) > Date.now()) continue
        // Advance before awaiting: a socket-closing watch must not lead the next reconnect.
        this.lastWatch = watch.runtime
        try {
          const replay = await this.gateway.request<Replay>('session.events.since', { session_id: watch.runtime, last_seen: watch.seq, profile: watch.profile }, 20_000)
          if (this.stopped || !this.valid()) return
          const notices = replayNotifications(watch, replay)
          if (!notices.length) { this.store.saveWatch(this.owner, watch); this.watchFailures.delete(watch.runtime); continue }
          const identity = await this.native.request('/api/auth/me')
          if (identity.status === 401) throw new BridgeError(401, 'Login expired.')
          if (!identity.ok) throw new Error('Authentication unavailable.')
          const titleResponse = await this.native.request(`/api/sessions/${encodeURIComponent(watch.stored)}?${new URLSearchParams({ profile: watch.profile })}`)
          if (titleResponse.status === 401) throw new BridgeError(401, 'Login expired.')
          if (!titleResponse.ok) throw new Error('Conversation unavailable.')
          const detail = await titleResponse.json()
          const title = detail.title
          // Reserve before delivery: a crash may lose a notification, never persist its content or send it twice after restart.
          this.store.saveWatch(this.owner, watch)
          for (const notice of notices.slice(-16)) {
            for (const subscription of this.store.subscriptions(this.owner)) {
              if (this.stopped || !this.valid() || !this.store.subscriptions(this.owner).some(row => row.endpoint === subscription.endpoint)) return
              try {
                const authorized = () => !this.stopped && this.valid() && this.store.subscriptions(this.owner).some(row => row.endpoint === subscription.endpoint)
                await sendPush(this.config, subscription, notificationPayload(watch.stored, watch.profile, title, notice.kind, notice.text), authorized)
                this.deliveryUnavailable = false
              }
              catch (error) {
                this.deliveryUnavailable = true
                const status = (error as { statusCode?: number }).statusCode
                if (status === 404 || status === 410) this.store.deleteSubscription(this.owner, subscription.endpoint)
                // Provider errors can include endpoints and payloads. Never log their raw response.
              }
            }
          }
          this.watchFailures.delete(watch.runtime)
        } catch (error) {
          if (this.stopped) return
          if (error instanceof BridgeError && error.status === 401) throw error
          const count = Math.min(5, (this.watchFailures.get(watch.runtime)?.count || 0) + 1)
          this.watchFailures.set(watch.runtime, { count, retryAt: Date.now() + Math.min(60_000, 3000 * 2 ** count) })
          if (!this.connected || error instanceof ConnectionLost) {
            this.connected = false; this.gateway.close()
            break
          }
        }
      }
      this.status = this.watchFailures.size ? 'unavailable' : this.deliveryUnavailable ? 'delivery-unavailable' : 'watching'; this.failures = 0
    } catch (error) {
      if (this.stopped) return
      if (error instanceof BridgeError && error.status === 401) { this.revoke(); return }
      this.status = 'unavailable'; this.failures++
      this.connected = false; this.gateway.close()
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), Math.min(60_000, 3000 * 2 ** Math.min(this.failures, 4)))
        this.timer.unref()
      }
    }
  }
}
