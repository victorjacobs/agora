import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import MarkdownMessage from '../src/MarkdownMessage.vue'
import ThinkingTrace from '../src/ThinkingTrace.vue'
import * as media from '../src/hermes/media'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren() })

async function mountMessage(text: string) {
  const props = reactive({ text })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(MarkdownMessage, props) })
  app.mount(host)
  cleanup = () => app.unmount()
  await nextTick()
  return { host, props }
}

const settle = async () => { await Promise.resolve(); await nextTick() }

describe('code block copying', () => {
  it('copies only the exact rendered block, leaves inline code and reasoning alone, and resets feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { host } = await mountMessage('Inline `not a block`.\n\n```ts\n  const html = "<button> & text"\n\n\treturn html\n```\n\n    indented\n      two spaces\n')
    const buttons = host.querySelectorAll<HTMLButtonElement>('.code-copy')
    expect(buttons).toHaveLength(2)
    expect(host.querySelector('p code button')).toBeNull()
    buttons[0]!.click()
    await settle()
    expect(writeText).toHaveBeenLastCalledWith('  const html = "<button> & text"\n\n\treturn html\n')
    expect(buttons[0]!.textContent).toBe('Copied')
    buttons[1]!.click()
    await settle()
    expect(writeText).toHaveBeenLastCalledWith('indented\n  two spaces\n')
    vi.advanceTimersByTime(2000)
    expect(buttons[0]!.textContent).toBe('Copy code')
    expect(buttons[1]!.textContent).toBe('Copy code')
    const trace = document.createElement('div')
    const app = createApp(ThinkingTrace, { text: '```\nno dead buttons\n```', active: false })
    app.mount(trace)
    expect(trace.querySelector('button.code-copy')).toBeNull()
    app.unmount()
  })

  it.each(['rejected', 'unavailable'])('shows a %s clipboard failure and selects only code for manual copying', async mode => {
    vi.stubGlobal('navigator', mode === 'rejected' ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } } : {})
    const { host } = await mountMessage('```\n  select <this> & only this\n```')
    host.querySelector<HTMLButtonElement>('.code-copy')!.click()
    await settle()
    expect(host.querySelector('.code-copy')!.textContent).toBe('Copy code')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Copy failed. Code selected; copy it manually.')
    expect(window.getSelection()!.toString()).toBe('  select <this> & only this\n')
    expect(host.querySelector('.code-copy')!.hasAttribute('disabled')).toBe(false)
    expect(host.querySelector('this')).toBeNull()
  })

  it('ignores late copy results after streamed replacement or unmount without duplicating toolbars', async () => {
    vi.useFakeTimers()
    let resolve!: () => void
    const writeText = vi.fn(() => new Promise<void>(done => { resolve = done }))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let resolveImage!: (data: string) => void
    vi.spyOn(media, 'loadImage').mockImplementation(() => new Promise<string>(done => { resolveImage = done }))
    const { host, props } = await mountMessage('```\nfirst\n```\n\n![Example](/workspace/example.png)')
    const original = host.querySelector<HTMLButtonElement>('.code-copy')!
    original.click()
    expect(writeText).toHaveBeenCalledWith('first\n')
    resolveImage('data:image/png;base64,aGVsbG8=')
    await settle()
    expect(host.querySelector('img')).not.toBeNull()
    expect(host.querySelectorAll('.code-toolbar')).toHaveLength(1)
    props.text = '```\nfirst\n  streamed line\n```\n\n```\nsecond\n```'
    await nextTick()
    resolve()
    await settle()
    expect(host.querySelectorAll('.code-toolbar')).toHaveLength(2)
    expect(host.querySelectorAll('.code-block .code-block')).toHaveLength(0)
    expect(host.textContent).not.toContain('Copied')
    expect(vi.getTimerCount()).toBe(0)
    const replacement = host.querySelector<HTMLButtonElement>('.code-copy')!
    replacement.click()
    expect(writeText).toHaveBeenLastCalledWith('first\n  streamed line\n')
    cleanup()
    resolve()
    await settle()
    expect(replacement.textContent).toBe('Copy code')
    expect(vi.getTimerCount()).toBe(0)
  })
})
