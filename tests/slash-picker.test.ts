import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import SlashCommands from '../src/SlashCommands.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('command picker', () => {
  it('loads on demand, filters, selects with keyboard, dismisses, and reloads for a new scope', async () => {
    const props = reactive({ draft: '', scope: 'a', connected: true, load: vi.fn().mockResolvedValue([{ name: '/help', description: 'Help' }, { name: '/context', description: 'Context' }]) })
    let picker!: InstanceType<typeof SlashCommands>
    const select = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({ render: () => h(SlashCommands, { ...props, ref: (instance: unknown) => { picker = instance as typeof picker }, onSelect: select }) })
    app.mount(host)
    cleanup = () => app.unmount()
    expect(props.load).not.toHaveBeenCalled()
    props.draft = '/'
    await vi.waitFor(() => expect(host.querySelectorAll('[role=option]')).toHaveLength(2))
    picker.keydown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    picker.keydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(select).toHaveBeenCalledWith('/context ')
    props.draft = '/h'
    await nextTick()
    expect(host.querySelectorAll('[role=option]')).toHaveLength(1)
    picker.keydown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await nextTick()
    expect(host.querySelector('.slash-picker')).toBeNull()
    props.draft = '/'
    await nextTick()
    expect(props.load).toHaveBeenCalledTimes(1)
    props.scope = 'b'
    await vi.waitFor(() => expect(props.load).toHaveBeenCalledTimes(2))
  })

  it('shows unavailable catalog errors without treating text as HTML', async () => {
    const host = document.createElement('div')
    const app = createApp(SlashCommands, { draft: '/', scope: 'a', connected: true, load: async () => { throw new Error('<img src=x> Unsupported method') } })
    app.mount(host)
    cleanup = () => app.unmount()
    await vi.waitFor(() => expect(host.textContent).toContain('Unsupported method'))
    expect(host.querySelector('img')).toBeNull()
  })
})
