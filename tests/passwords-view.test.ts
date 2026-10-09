import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import PasswordsView from '../src/PasswordsView.vue'
import { ConnectionLost, RpcError } from '../src/hermes/gateway'
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
function mount() {
  const list = vi.fn().mockResolvedValue([{ id: 'vault_a', label: 'Local test', origin: 'https://example.test', identifier: 'me', identifier_type: 'username', backend: 'local', created_at: '', has_otp: false }, { id: 'external', label: 'External test', origin: 'https://example.test', identifier: 'me', backend: 'bw' }])
  const api = { list, sources: vi.fn().mockResolvedValue([{ name: 'local', display_name: 'Hermes vault', enabled: true, installed: true, unlocked: true }]), add: vi.fn().mockResolvedValue('vault_new'), remove: vi.fn().mockResolvedValue(true) }
  const props = reactive({ active: true, connected: true, profile: 'work', section: 'logins' as 'logins' | 'sources' })
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp({ render: () => h(PasswordsView, { ...props, api }) }); app.mount(host); cleanup = () => app.unmount()
  const click = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!.click()
  const fill = async () => { click('Add login'); await nextTick(); for (const [name, value] of Object.entries({ label: 'Dummy', origin: 'https://example.test', identifier: 'me', password: 'dummy-secret' })) { const input = host.querySelector<HTMLInputElement>(`[name=${name}]`)!; input.value = value; input.dispatchEvent(new Event('input')) } await nextTick() }
  return { api, props, host, click, fill }
}
describe('Passwords workspace', () => {
  it('requires explicit reconciliation after disconnecting during an in-flight write', async () => {
    const { api, host, props, fill, click } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    let reject!: (value: Error) => void
    api.add.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r }))
    await fill(); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    props.connected = false; await nextTick()
    reject(new ConnectionLost()); await nextTick(); await nextTick()
    props.connected = true; await nextTick(); await nextTick()
    expect(host.textContent).toContain('may have reached Hermes')
    expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Add login')!.disabled).toBe(true)
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledTimes(1)
    click('Refresh')
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Add login')!.disabled).toBe(false))
    expect(api.list).toHaveBeenCalledTimes(2)
  })
  it('loads a new profile during an old write and ignores the old completion', async () => {
    const { api, host, props, fill } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    let resolve!: (value: string) => void
    api.add.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    await fill(); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    props.profile = 'other'; await nextTick()
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('other'))
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    await fill()
    resolve('vault_old'); await nextTick(); await nextTick()
    expect(host.querySelector<HTMLInputElement>('[name=password]')?.value).toBe('dummy-secret')
    expect(host.textContent).not.toContain('acknowledged')
  })
  it('clears passwords on cancel and unmount', async () => {
    const { host, fill, click } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    await fill(); const input = host.querySelector<HTMLInputElement>('[name=password]')!
    click('Cancel'); await nextTick(); expect(input.value).toBe('')
    await fill(); cleanup(); cleanup = () => {}
    expect(host.querySelector('form')).toBeNull()
  })
  it('verifies an acknowledged addition against refreshed metadata', async () => {
    const { api, host, fill } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    api.list.mockResolvedValueOnce([{ id: 'vault_new', label: 'Dummy', origin: 'https://example.test', identifier: 'me', identifier_type: 'email', backend: 'local', created_at: '', has_otp: false }])
    await fill(); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('Login saved and verified'))
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenLastCalledWith('work')
  })
  it('does not claim a saved login is verified when refreshed metadata omits it', async () => {
    const { host, fill } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test')); await fill()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('acknowledged the action, but its effect'))
  })
  it('clears transient secrets on submit and never echoes failed mutation details', async () => {
    const { api, host, fill } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    api.add.mockRejectedValueOnce(new RpcError(5095, 'dummy-secret internal detail'))
    await fill(); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('could not complete'))
    expect(host.querySelector('[name=password]')).toBeNull()
    expect(host.innerHTML).not.toContain('dummy-secret')
    expect(api.add).toHaveBeenCalledTimes(1)
  })
  it('blocks ambiguous writes until an explicit list refresh without replay', async () => {
    const { api, host, fill, click } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    api.add.mockRejectedValueOnce(new ConnectionLost())
    await fill(); host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('may have reached Hermes'))
    expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Add login')!.disabled).toBe(true)
    expect(api.add).toHaveBeenCalledTimes(1); click('Refresh')
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Add login')!.disabled).toBe(false))
  })
  for (const transition of ['navigation', 'disconnect', 'profile', 'section']) it(`clears secrets on ${transition}`, async () => {
    const { host, props, fill } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test')); await fill()
    if (transition === 'navigation') props.active = false
    if (transition === 'disconnect') props.connected = false
    if (transition === 'profile') props.profile = 'other'
    if (transition === 'section') props.section = 'sources'
    await nextTick(); expect(host.querySelector('[name=password]')).toBeNull()
  })
  it('discards read replies from an old profile', async () => {
    const { api, props, host } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    let resolve!: (value: unknown) => void
    api.list.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    props.profile = 'old'; await nextTick(); props.profile = 'new'; await nextTick()
    resolve([{ label: 'Stale secret metadata', backend: 'local', id: 'old' }]); await nextTick(); await nextTick()
    expect(host.textContent).not.toContain('Stale secret metadata')
  })
  it('shows unsupported methods without backend fallback', async () => {
    const { api, props, host } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local test'))
    api.list.mockRejectedValue(new RpcError(-32601, 'no method')); props.profile = 'other'
    await vi.waitFor(() => expect(host.textContent).toContain('unavailable on this Hermes version'))
  })
  it('lists metadata, keeps external logins read-only and confirms local removal', async () => {
    const { api, host, click } = mount()
    await vi.waitFor(() => expect(host.textContent).toContain('External test'))
    expect(host.querySelectorAll('[data-remove]')).toHaveLength(1)
    click('Remove'); await nextTick(); expect(api.remove).not.toHaveBeenCalled()
    click('Remove login'); await vi.waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1))
    expect(api.list).toHaveBeenCalledTimes(2)
  })
})
