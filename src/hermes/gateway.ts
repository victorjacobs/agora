import type { GatewayEvent, ServerRequest } from './types'

export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message) }
}

export class ConnectionLost extends Error {
  constructor() { super('Connection lost. The outcome of an in-flight action may be unknown.') }
}

export interface Socket {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onmessage: WebSocket["onmessage"]
  onclose: WebSocket["onclose"]
  onerror: WebSocket["onerror"]
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Gateway {
  onEvent: (event: GatewayEvent) => void = () => {}
  onRequest: (request: ServerRequest) => void = () => {}
  onDisconnect: (code: number) => void = () => {}
  private pending = new Map<string, Pending>()
  private socket?: Socket
  private nextId = 0
  private heartbeat?: ReturnType<typeof setInterval>
  private lastInbound = 0
  private generation = 0
  private ready = false

  constructor(private factory: (url: string, protocols: string[]) => Socket = (url, protocols) => new WebSocket(url, protocols)) {}

  connect(url: string, ticket?: string): Promise<void> {
    this.close()
    const generation = this.generation
    const socket = this.factory(url, ticket ? ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`] : ['hermes-gateway-v1'])
    this.socket = socket
    this.lastInbound = Date.now()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new ConnectionLost()); socket.close() }, 15_000)
      socket.onmessage = event => {
        if (generation !== this.generation) return
        if (typeof event.data !== 'string') { socket.close(1002); return }
        this.lastInbound = Date.now()

        try {
          for (const line of event.data.split('\n').filter(line => line.trim())) {
            const frame = JSON.parse(line)
            if (frame.jsonrpc !== '2.0') throw new Error('Unsupported protocol')
            if (frame.method === 'event' && typeof frame.params?.type === 'string') {
              const notification = frame.params as GatewayEvent
              if (notification.type === 'gateway.ready') {
                this.ready = true
                clearTimeout(timeout)
                if (notification.payload?.heartbeat === true) this.startHeartbeat()
                resolve()
              }
              this.onEvent(notification)
            } else if (typeof frame.method === 'string' && frame.id !== undefined) {
              this.onRequest({ id: String(frame.id), method: frame.method, params: frame.params || {} })
            } else if (frame.id !== undefined) {
              const id = String(frame.id)
              const pending = this.pending.get(id)
              if (!pending) continue
              this.pending.delete(id)
              clearTimeout(pending.timer)
              if (frame.error) pending.reject(new RpcError(frame.error.code, frame.error.message))
              else pending.resolve(frame.result)
            }
          }
        } catch {
          reject(new Error('Hermes sent an incompatible gateway frame.'))
          socket.close(1002)
        }
      }
      socket.onclose = event => {
        if (generation !== this.generation) return
        clearTimeout(timeout)
        reject(new ConnectionLost())
        this.clearPending()
        this.ready = false
        this.stopHeartbeat()
        this.onDisconnect(event.code)
      }
      socket.onerror = () => socket.close()
    })
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    if (!this.ready || this.socket?.readyState !== 1) return Promise.reject(new ConnectionLost())
    const id = `agora-${++this.nextId}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ConnectionLost())
        this.socket?.close()
      }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })) }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new ConnectionLost()); this.socket?.close() }
    })
  }

  close() {
    this.generation++
    this.ready = false
    this.stopHeartbeat()
    this.clearPending()
    if (this.socket) {
      this.socket.onclose = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.close()
      this.socket = undefined
    }
  }

  private clearPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ConnectionLost()) }
    this.pending.clear()
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastInbound >= 45_000) { this.socket?.close(); return }
      void this.request('gateway.ping', {}, 45_000).catch(() => {})
    }, 15_000)
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}
