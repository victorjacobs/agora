import type { notificationState } from './reply-notifications'

type State = ReturnType<typeof notificationState>
interface Status { configured: boolean; publicKey?: string; devices: string[]; observer: string; watched: number }
const preference = 'agora.web-push-enabled'
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

export class PushNotifications {
  private registration?: ServiceWorkerRegistration
  private publicKey = ''
  private disposed = false
  private refreshing = false
  constructor(private state: State, private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    window.addEventListener('focus', this.focus)
  }
  private focus = () => { void this.refresh() }
  private async request(method = 'GET', body?: unknown) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher('/api/agora/push', { method, signal: controller.signal, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to manage notifications.' : response.status === 400 ? 'This device or push provider is not supported by this server.' : 'Could not update Web Push. Check your connection and server configuration.')
      return await response.json()
    } finally { clearTimeout(timer) }
  }
  private save(enabled: boolean) {
    this.state.pushEnabled = enabled
    try { localStorage.setItem(preference, String(enabled)) } catch { /* No transcript or subscription is stored in the browser. */ }
  }
  async refresh() {
    if (this.disposed || this.refreshing || this.state.busy) return
    this.refreshing = true
    this.state.busy = true
    try {
      this.state.pushSupported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
      if (isIOS() && !installed()) {
        this.state.pushSupported = false
        this.state.help = 'On iPhone or iPad, use Share → Add to Home Screen, open the installed Agora app, then enable notifications (iOS/iPadOS 16.4 or later).'
      } else if (!this.state.pushSupported) this.state.help = 'Background notifications require HTTPS and a browser supporting Service Workers and Web Push. Desktop notifications, if available, work only while Agora is open.'
      const status = await this.request() as Status
      if (this.disposed) return
      this.state.pushConfigured = status.configured === true
      this.publicKey = status.publicKey || ''
      this.state.pushStatus = status.observer || 'off'
      if (!status.configured) { this.state.help = 'Web Push is not configured on this server. Desktop-only notifications require Agora to stay open and connected.'; this.save(false); return }
      if (!this.state.pushSupported) return
      this.registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      await navigator.serviceWorker.ready
      const subscription = await this.registration.pushManager.getSubscription()
      let enabled = false
      if (subscription) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint))
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        enabled = status.devices.includes(hash) && Notification.permission === 'granted'
        if (!enabled) {
          if (status.devices.includes(hash)) await this.request('DELETE', { endpoint: subscription.endpoint })
          await subscription.unsubscribe()
        }
      }
      if (this.disposed) return
      this.save(enabled)
      this.state.permission = Notification.permission
      this.state.help = enabled ? `Background replies and attention requests for chats opened in Agora. Lock screen shows titles and short previews; secure inputs stay generic. ${status.observer === 'watching' ? '' : 'Watcher: ' + status.observer + '. '}Up to 64 chats per login. Notifications may also appear while Agora is visible.` : 'Enable on this device for replies, approvals and questions, even when Agora is closed. Titles and short previews can appear on the lock screen. Secure-input requests use generic text.'
    } catch {
      if (!this.disposed) { this.state.pushStatus = 'unavailable'; this.state.help = 'Web Push status is unavailable. Reconnect or sign in again; existing delivery may be paused.' }
    } finally { this.refreshing = false; this.state.busy = false }
  }
  async toggle() {
    if (this.disposed || this.state.busy) return
    this.state.error = ''
    if (!this.state.pushEnabled && (!this.state.pushConfigured || !this.state.pushSupported || !this.publicKey)) return
    this.state.busy = true
    let created: PushSubscription | undefined
    try {
      // Call permission before the first await: iOS requires the original button gesture.
      const permission = !this.state.pushEnabled && Notification.permission !== 'granted' ? Notification.requestPermission() : Promise.resolve(Notification.permission)
      if (this.state.pushEnabled) {
        const subscription = await this.registration?.pushManager.getSubscription()
        if (subscription) { await this.request('DELETE', { endpoint: subscription.endpoint }); await subscription.unsubscribe() }
        this.save(false)
        for (const notification of await this.registration?.getNotifications() || []) notification.close()
        return
      }
      this.state.permission = await permission
      if (this.state.permission !== 'granted') throw new Error('Notifications are blocked or permission was not granted. Allow notifications in browser or device settings and try again.')
      if (this.disposed) return
      const registration = this.registration || await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      await navigator.serviceWorker.ready
      this.registration = registration
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        const bytes = Uint8Array.from(atob(this.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
        created = subscription
      }
      if (this.disposed) { if (created) await created.unsubscribe(); return }
      await this.request('POST', { subscription: subscription.toJSON() })
      this.save(true)
      this.state.pushStatus = 'connecting'
      this.state.help = 'Background notifications enabled on this device. Replies and questions may show titles and short previews on the lock screen; secure inputs stay generic. Only chats opened in Agora are watched.'
    } catch (error) {
      if (created) await created.unsubscribe().catch(() => {})
      if (!this.disposed) this.state.error = error instanceof Error ? error.message : 'Could not enable Web Push.'
    } finally { this.state.busy = false }
  }
  async clearDevice() {
    this.save(false)
    try {
      const registration = this.registration || await navigator.serviceWorker?.getRegistration('/')
      const subscription = await registration?.pushManager.getSubscription()
      await subscription?.unsubscribe()
      for (const notification of await registration?.getNotifications() || []) notification.close()
    } catch { /* Server-side logout/revocation independently deletes linked metadata. */ }
  }
  dispose() { this.disposed = true; window.removeEventListener('focus', this.focus) }
}
