import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ProviderQuota from '../src/ProviderQuota.vue'
import { RpcError } from '../src/hermes/gateway'
import type { ProviderQuota as Quota } from '../src/hermes/quota'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
const providers = [{ slug: 'openai-codex', name: 'Codex', models: ['gpt'] }, { slug: 'anthropic', name: 'Claude', models: ['claude'] }]
const snapshot: Quota = { windows: [{ label: 'Weekly', remaining: 70 }], details: [], plan: 'Plus' }
function mount(load: (provider: string, profile?: string) => Promise<Quota>, choices = providers) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(ProviderQuota, { providers: choices, currentProvider: 'openai-codex', profile: 'work', connected: true, load })
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}
async function select(host: HTMLElement, value: string) {
  host.querySelector('select')!.value = value
  host.querySelector('select')!.dispatchEvent(new Event('change'))
  await nextTick()
}

describe('quota picker', () => {
  it('loads only on demand and lets the user query multiple providers independently', async () => {
    const load = vi.fn().mockResolvedValue(snapshot)
    const host = mount(load)
    expect(load).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('.quota-toggle')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('70% left'))
    expect(load).toHaveBeenLastCalledWith('openai-codex', 'work')
    expect(host.querySelector('meter')?.getAttribute('value')).toBe('70')
    load.mockResolvedValue({ windows: [], details: ['Credits: $12'] })
    await select(host, 'anthropic')
    await vi.waitFor(() => expect(host.textContent).toContain('Credits: $12'))
    await select(host, 'openai-codex')
    await vi.waitFor(() => expect(host.textContent).toContain('70% left'))
    expect(load).toHaveBeenCalledTimes(2)
    host.querySelector<HTMLButtonElement>('.quota-toggle')!.click()
    await nextTick()
    expect(load).toHaveBeenCalledTimes(2)
    host.querySelector<HTMLButtonElement>('.quota-toggle')!.click()
    await nextTick()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows the actual request failure and can retry successfully', async () => {
    const load = vi.fn().mockRejectedValueOnce(new RpcError(5016, 'cli.exec: timeout')).mockResolvedValue(snapshot)
    const host = mount(load, [providers[0]!])
    host.querySelector<HTMLButtonElement>('.quota-toggle')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('Hermes timed out'))
    expect(host.querySelector('select')).toBeNull()
    expect(host.querySelector('.quota-provider-name')?.textContent).toBe('Codex')
    host.querySelector<HTMLButtonElement>('.quota-refresh')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('70% left'))
    expect(host.textContent).not.toContain('timed out')
  })

  it('discards an obsolete provider reply and renders provider details as plain text', async () => {
    let resolve!: (value: Quota) => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<Quota>(done => { resolve = done })).mockResolvedValue({ windows: [], details: ['<img src=x onerror=alert(1)>'] })
    const host = mount(load)
    host.querySelector<HTMLButtonElement>('.quota-toggle')!.click()
    await nextTick()
    await select(host, 'anthropic')
    await vi.waitFor(() => expect(host.textContent).toContain('<img'))
    resolve(snapshot)
    await nextTick()
    expect(host.textContent).not.toContain('70% left')
    expect(host.querySelector('img')).toBeNull()
  })
})
