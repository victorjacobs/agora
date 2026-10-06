import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notificationState, ReplyNotifications } from '../src/reply-notifications'

class FakeNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted')
  static instances: FakeNotification[] = []
  onclick?: () => void
  onclose?: () => void
  onerror?: () => void
  close = vi.fn()
  constructor(public title: string, public options: NotificationOptions) { FakeNotification.instances.push(this) }
}
let controller: ReplyNotifications | undefined
beforeEach(() => {
  FakeNotification.instances = []
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission = vi.fn(async () => { FakeNotification.permission = 'granted'; return 'granted' })
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('isSecureContext', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => { controller?.dispose(); controller = undefined; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup() {
  const state = notificationState()
  let endpoint = 'https://hermes.test'
  const open = vi.fn()
  controller = new ReplyNotifications(state, () => endpoint, open)
  return { state, notifications: controller, open, changeEndpoint: () => { endpoint = 'https://other.test' } }
}
describe('desktop response notifications', () => {
  it('requests permission only on opt-in and persists the preference', async () => {
    const { notifications, state } = setup()
    notifications.show({ id: 'chat' })
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(FakeNotification.instances).toHaveLength(0)
    await notifications.toggle()
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(state.enabled).toBe(true)
    expect(localStorage.getItem('agora.reply-notifications')).toBe('true')
    await notifications.toggle()
    expect(state.enabled).toBe(false)
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })
  it('notifies only while unfocused and opens the exact profile on click without exposing text', async () => {
    const { notifications, open } = setup()
    await notifications.toggle()
    const focused = vi.mocked(document.hasFocus)
    focused.mockReturnValue(true)
    notifications.show({ id: 'chat', profile: 'work', title: 'Secret title' })
    expect(FakeNotification.instances).toHaveLength(0)
    focused.mockReturnValue(false)
    notifications.show({ id: 'chat', profile: 'work', title: 'Secret title' })
    const notification = FakeNotification.instances[0]!
    expect(notification.title).toBe('Hermes response ready')
    expect(JSON.stringify(notification.options)).not.toContain('Secret title')
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    notification.onclick!()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ id: 'chat', profile: 'work', title: 'Secret title' })
    expect(notification.close).toHaveBeenCalled()
  })
  it('handles denied permissions without re-prompting or displaying notifications', async () => {
    FakeNotification.permission = 'denied'
    const { notifications, state } = setup()
    await notifications.toggle()
    expect(state.enabled).toBe(false)
    expect(state.error).toContain('blocked')
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    notifications.show({ id: 'chat' })
    expect(FakeNotification.instances).toHaveLength(0)
  })
  it('restores opt-in but respects revoked permission and closes notifications on disable', async () => {
    localStorage.setItem('agora.reply-notifications', 'true')
    FakeNotification.permission = 'granted'
    const { notifications } = setup()
    notifications.show({ id: 'chat' })
    FakeNotification.permission = 'denied'
    notifications.show({ id: 'other' })
    expect(FakeNotification.instances).toHaveLength(1)
    await notifications.toggle()
    expect(FakeNotification.instances[0]!.close).toHaveBeenCalled()
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })
  it('cannot open a notification from another endpoint or after disposal', async () => {
    const { notifications, open, changeEndpoint } = setup()
    await notifications.toggle()
    notifications.show({ id: 'chat' })
    changeEndpoint()
    FakeNotification.instances[0]!.onclick!()
    expect(open).not.toHaveBeenCalled()
    notifications.show({ id: 'other' })
    notifications.dispose()
    FakeNotification.instances[1]!.onclick!()
    expect(open).not.toHaveBeenCalled()
  })
  it('does not enable itself when permission or storage fails', async () => {
    FakeNotification.requestPermission.mockRejectedValueOnce(new Error('Denied'))
    const { notifications, state } = setup()
    await notifications.toggle()
    expect(state.enabled).toBe(false)
    expect(state.busy).toBe(false)
    expect(state.error).toContain('Could not enable')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    await notifications.toggle()
    expect(state.enabled).toBe(false)
    expect(state.error).toContain('Could not save')
  })
})
