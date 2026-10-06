import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import MemoryStateView from '../src/MemoryStateView.vue'
import type { MemoryInspection, MemoryInspectionSection } from '../src/hermes/memory-state'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
function mount() {
  const props = reactive({ active: false, section: 'memory' as MemoryInspectionSection, runtime: 'runtime', profile: 'work', connected: true,
    load: vi.fn<(section: MemoryInspectionSection, profile?: string) => Promise<MemoryInspection>>().mockResolvedValue({ profile: 'work', entries: [{ id: 'memory:memory:0:abc123', title: 'A memory', preview: 'Short preview' }] }),
    mutate: vi.fn<(id: string, profile: string, content?: string) => Promise<void>>().mockResolvedValue(),
    read: vi.fn<(id: string, profile: string) => Promise<string>>().mockResolvedValue('Full text\n<img src=x onerror=alert(1)>'),
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(MemoryStateView, props) })
  app.mount(host)
  cleanup = () => app.unmount()
  return { props, host }
}

describe('memory state views', () => {
  it('edits full text, preserves a failed draft, and refreshes only after a confirmed save', async () => {
    const { props, host } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.saved-memory-entry')).not.toBeNull())
    const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click()
    click('Read full entry')
    await vi.waitFor(() => expect(host.querySelector('.entry-content')).not.toBeNull())
    click('Edit')
    await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull())
    expect(props.read).toHaveBeenCalledTimes(2)
    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toContain('Full text')
    textarea.value = 'Updated memory'
    textarea.dispatchEvent(new Event('input'))
    await nextTick()
    props.mutate.mockRejectedValueOnce(new Error('Entry is stale — refresh the list'))
    click('Save changes')
    await vi.waitFor(() => expect(host.textContent).toContain('Entry is stale'))
    expect(textarea.value).toBe('Updated memory')
    expect(props.load).toHaveBeenCalledTimes(1)
    expect(props.mutate).toHaveBeenCalledExactlyOnceWith('memory:memory:0:abc123', 'work', 'Updated memory')
    props.load.mockResolvedValue({ profile: 'work', entries: [{ id: 'memory:memory:0:abcd', title: 'Updated memory', preview: 'Updated memory' }] })
    click('Save changes')
    await vi.waitFor(() => expect(host.textContent).toContain('Memory updated.'))
    expect(props.load).toHaveBeenCalledTimes(2)
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('requires a full-entry delete confirmation and prevents duplicate submissions', async () => {
    const { props, host } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.saved-memory-entry')).not.toBeNull())
    const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click()
    click('Read full entry')
    await vi.waitFor(() => expect(host.querySelector('.entry-content')).not.toBeNull())
    click('Delete')
    await nextTick()
    await vi.waitFor(() => expect(host.querySelector('.delete-notice')).not.toBeNull())
    expect(props.mutate).not.toHaveBeenCalled()
    click('Cancel')
    await nextTick()
    expect(host.querySelector('.delete-notice')).toBeNull()
    click('Delete')
    await nextTick()
    await vi.waitFor(() => expect(host.querySelector('.entry-content')).not.toBeNull())
    let finish!: () => void
    props.mutate.mockImplementationOnce(() => new Promise(done => { finish = done }))
    click('Delete memory')
    await nextTick()
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Deleting…')?.disabled).toBe(true)
    expect(props.mutate).toHaveBeenCalledExactlyOnceWith('memory:memory:0:abc123', 'work', undefined)
    props.load.mockResolvedValue({ profile: 'work', entries: [] })
    finish()
    await vi.waitFor(() => expect(host.textContent).toContain('Memory deleted.'))
    expect(host.querySelector('.saved-memory-entry')).toBeNull()
  })

  it('does not apply a delayed mutation result to another profile', async () => {
    const { props, host } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.saved-memory-entry')).not.toBeNull())
    const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click()
    click('Read full entry')
    await vi.waitFor(() => expect(host.querySelector('.entry-content')).not.toBeNull())
    click('Delete')
    await nextTick()
    await vi.waitFor(() => expect(host.querySelector('.entry-content')).not.toBeNull())
    let finish!: () => void
    props.mutate.mockImplementationOnce(() => new Promise(done => { finish = done }))
    click('Delete memory')
    await nextTick()
    props.load.mockResolvedValue({ profile: 'personal', entries: [] })
    props.profile = 'personal'
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    finish()
    await nextTick()
    expect(host.textContent).not.toContain('Memory deleted.')
    expect(props.load).toHaveBeenCalledTimes(2)
  })

  it('loads only while open and fetches full entries only on request', async () => {
    const { props, host } = mount()
    expect(props.load).not.toHaveBeenCalled()
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.entry-preview')?.textContent).toBe('Short preview'))
    expect(props.read).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('.saved-memory-entry button')!.click()
    await vi.waitFor(() => expect(host.querySelector('.entry-content')?.textContent).toContain('Full text'))
    expect(props.read).toHaveBeenCalledExactlyOnceWith('memory:memory:0:abc123', 'work')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('discards delayed results after switching profiles or closing the view', async () => {
    const { props, host } = mount()
    let resolve!: (value: MemoryInspection) => void
    props.load.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    props.active = true
    await nextTick()
    props.profile = 'personal'
    props.load.mockResolvedValue({ profile: 'personal', entries: [] })
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    resolve({ profile: 'work', entries: [{ id: 'old', title: 'Wrong profile', preview: '' }] })
    await nextTick()
    expect(host.textContent).not.toContain('Wrong profile')
    props.active = false
    await nextTick()
    expect(host.textContent).not.toContain('Profile: personal')
  })

  it('discards a full-entry response after its profile is no longer displayed', async () => {
    const { props, host } = mount()
    let resolve!: (value: string) => void
    props.read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.saved-memory-entry')).not.toBeNull())
    host.querySelector<HTMLButtonElement>('.saved-memory-entry button')!.click()
    await nextTick()
    expect(props.read).toHaveBeenCalledTimes(1)
    props.load.mockResolvedValue({ profile: 'personal', entries: [] })
    props.profile = 'personal'
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    resolve('Private text from the previous profile')
    await nextTick()
    expect(host.textContent).not.toContain('Private text from the previous profile')
  })

  it('renders soul text safely and keeps independent unavailable sections visible', async () => {
    const { props, host } = mount()
    props.section = 'soul'
    props.load.mockResolvedValue({ profile: 'work', soul: '<script>unsafe()</script>', personality: 'none', prompt: '', errors: ['Some setting unavailable'] })
    props.active = true
    await vi.waitFor(() => expect(host.querySelector('.document-text')?.textContent).toContain('<script>'))
    expect(host.querySelector('script')).toBeNull()
    expect(host.textContent).toContain('None selected')
    expect(host.textContent).toContain('Some setting unavailable')
    expect(host.textContent).toContain('No custom instructions configured')
  })
})
