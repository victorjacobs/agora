import { createECDH, ECDH } from 'node:crypto'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import webpush from 'web-push'
import { BridgeError } from './native-session.ts'

export type Subscription = webpush.PushSubscription
export interface PushConfig { subject: string; publicKey: string; privateKey: string }

export function pushConfiguration(environment: NodeJS.ProcessEnv = process.env): PushConfig | undefined {
  const path = environment.AGORA_PUSH_VAPID_FILE
  if (!path) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as PushConfig
  if (!value.subject || !/^(mailto:|https:\/\/)/.test(value.subject)) throw new Error('VAPID subject must be an operator mailto or HTTPS contact.')
  const key = createECDH('prime256v1'); key.setPrivateKey(Buffer.from(value.privateKey, 'base64url'))
  if (key.getPublicKey().toString('base64url') !== value.publicKey) throw new Error('VAPID key pair does not match.')
  return value
}

export function validateSubscription(input: unknown): Subscription {
  const value = input as Partial<Subscription> | null
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw new BridgeError(400, 'Invalid push subscription.')
  let url: URL
  try { url = new URL(value.endpoint) } catch { throw new BridgeError(400, 'Invalid push endpoint.') }
  const host = url.hostname
  const trusted = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(host) || host === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)
  if (!trusted || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw new BridgeError(400, 'Unsupported push provider.')
  const decode = (value: unknown, size: number) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new BridgeError(400, 'Invalid push encryption keys.')
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length !== size || bytes.toString('base64url') !== value) throw new BridgeError(400, 'Invalid push encryption keys.')
    return bytes
  }
  const publicKey = decode(value.keys?.p256dh, 65)
  decode(value.keys?.auth, 16)
  try { ECDH.convertKey(publicKey, 'prime256v1') } catch { throw new BridgeError(400, 'Invalid push public key.') }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys!.p256dh, auth: value.keys!.auth } }
}

export interface NotificationPayload { title: string; body: string; url: string; tag: string }
export function plainPreview(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return Array.from(value.slice(0, 4096).replace(/MEDIA:\s*\S+/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+|(?:\/[^\s/]+){2,}/g, '').replace(/[\u0000-\u001f\u007f`*_#<>]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
}
export function notificationPayload(stored: string, profile: string, title: unknown, kind: string, text?: unknown): NotificationPayload {
  const sensitive = kind === 'sudo' || kind.startsWith('vault.') || kind === 'secret'
  const body = sensitive ? 'Hermes needs secure input. Open Agora to continue.' : kind === 'approval' ? 'Hermes needs your approval. Open Agora to review.' : plainPreview(text, 160) || (kind === 'reply' ? 'Hermes response ready.' : 'Hermes has a question for you.')
  const query = new URLSearchParams({ session: stored, profile })
  return { title: sensitive ? 'Hermes needs your attention' : plainPreview(title, 80) || 'Hermes', body, url: `/?${query}`, tag: `agora:${profile}:${stored}` }
}

let activeDeliveries = 0
const waitingDeliveries: Array<() => void> = []
async function deliverySlot() {
  if (activeDeliveries >= 4) {
    if (waitingDeliveries.length >= 32) throw new Error('Push delivery busy.')
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { const index = waitingDeliveries.indexOf(ready); if (index >= 0) waitingDeliveries.splice(index, 1); reject(new Error('Push delivery busy.')) }, 10_000)
      waitingDeliveries.push(ready)
    })
  } else activeDeliveries++
  return () => { const next = waitingDeliveries.shift(); if (next) next(); else activeDeliveries-- }
}

export async function sendPush(config: PushConfig, subscription: Subscription, payload: NotificationPayload, authorized: () => boolean = () => true) {
  const release = await deliverySlot()
  try {
    if (!authorized()) return
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body, 'utf8') > 3000) throw new Error('Push payload exceeds the delivery limit.')
    const details = webpush.generateRequestDetails(subscription, body, {
      vapidDetails: config, TTL: 120, urgency: 'normal', contentEncoding: 'aes128gcm',
    })
    // Use the library's standard encryption/VAPID, but bound total transport time and never follow redirects.
    await new Promise<void>((resolve, reject) => {
      const url = new URL(details.endpoint)
      const request = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: details.method, headers: details.headers }, response => {
        let received = 0
        response.on('data', chunk => { received += chunk.length; if (received > 4096) request.destroy(new Error('Push provider response too large.')) })
        response.once('error', reject)
        response.once('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve()
          else reject(Object.assign(new Error('Push provider rejected delivery.'), { statusCode: response.statusCode }))
        })
      })
      const timer = setTimeout(() => request.destroy(new Error('Push delivery timeout.')), 10_000)
      request.once('error', reject)
      request.once('close', () => clearTimeout(timer))
      request.end(details.body)
    })
  } finally { release() }
}
