import type { SessionRow } from './hermes/types'

const preferenceKey = 'agora.reply-notifications'
export function notificationState() {
  return { supported: false, enabled: false, permission: 'default' as NotificationPermission, busy: false, error: '' }
}
type NotificationState = ReturnType<typeof notificationState>

export class ReplyNotifications {
  private disposed = false
  private shown = new Map<string, Notification>()
  constructor(public state: NotificationState, private endpoint: () => string, private open: (session: SessionRow) => void) {
    this.refreshPermission()
    try { state.enabled = localStorage.getItem(preferenceKey) === 'true' } catch { /* Browser storage may be unavailable. */ }
    window.addEventListener('focus', this.refreshPermission)
  }
  refreshPermission = () => {
    this.state.supported = window.isSecureContext && 'Notification' in window
    if (this.state.supported) this.state.permission = Notification.permission
  }
  async toggle() {
    if (this.state.busy || this.disposed) return
    this.refreshPermission()
    this.state.error = ''
    if (this.state.enabled) { this.save(false); this.clear(); return }
    if (!this.state.supported) { this.state.error = 'Desktop notifications require a supported browser and HTTPS or localhost.'; return }
    if (this.state.permission === 'denied') { this.state.error = 'Notifications are blocked. Allow them in your browser or macOS notification settings, then try again.'; return }
    this.state.busy = true
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
      if (this.disposed) return
      this.state.permission = permission
      if (permission === 'granted') this.save(true)
      else this.state.error = permission === 'denied' ? 'Notifications are blocked. Allow them in your browser or macOS notification settings.' : 'Notification permission was not granted.'
    } catch { if (!this.disposed) this.state.error = 'Could not enable desktop notifications.' }
    finally { this.state.busy = false }
  }
  private save(enabled: boolean) {
    try { localStorage.setItem(preferenceKey, String(enabled)); this.state.enabled = enabled }
    catch { this.state.error = 'Could not save notification preferences in this browser.' }
  }
  show(session: SessionRow) {
    this.refreshPermission()
    if (this.disposed || !this.state.enabled || !this.state.supported || this.state.permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    const endpoint = this.endpoint()
    const tag = JSON.stringify([endpoint, session.profile, session.id])
    try {
      const notification = new Notification('Hermes response ready', { body: 'Click to open the conversation.', icon: '/favicon-192.png', tag: `agora-response:${tag}` })
      const previous = this.shown.get(tag)
      previous?.close()
      this.shown.set(tag, notification)
      notification.onclick = () => {
        notification.close()
        if (this.disposed || endpoint !== this.endpoint()) return
        window.focus()
        this.open(session)
      }
      notification.onclose = () => { if (this.shown.get(tag) === notification) this.shown.delete(tag) }
      notification.onerror = () => { this.state.error = 'Could not display a desktop notification. Check browser and macOS notification settings.' }
    } catch { this.state.error = 'This browser could not display a desktop notification.' }
  }
  clear() { for (const notification of this.shown.values()) notification.close(); this.shown.clear() }
  dispose() { this.disposed = true; this.clear(); window.removeEventListener('focus', this.refreshPermission) }
}
