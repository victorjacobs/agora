import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import MarkdownMessage from '../src/MarkdownMessage.vue'
import { mockDialogs } from './helpers/dialog'

mockDialogs()
let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren(); document.querySelector('#agora-preview-frame-policy')?.remove() })
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
async function mount(allowPreviews = true) {
  const policy = document.createElement('meta')
  policy.id = 'agora-preview-frame-policy'; policy.httpEquiv = 'Content-Security-Policy'; policy.content = "frame-src 'none'"
  document.head.append(policy)
  const props = reactive({ text: 'Before\n\n::preview{file="/chart.html"}\n\nAfter', profile: 'work', allowPreviews })
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp({ render: () => h(MarkdownMessage, props) }); app.mount(host)
  cleanup = () => app.unmount()
  await settle()
  return { host, props }
}

describe('inline preview ownership and lifetime', () => {
  it('fails closed without the parent frame policy and aborts pending work on unmount', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const { host, props } = await mount()
    document.querySelector('#agora-preview-frame-policy')!.remove()
    props.profile = 'other'
    await settle()
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('required frame isolation policy is missing')
    expect(host.querySelector('iframe')).toBeNull()
    cleanup()
  })
  it('never starts a mixed old-profile/new-path fetch when both props change together', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('<h1>Chart</h1>'))
    vi.stubGlobal('fetch', fetcher)
    const { props } = await mount()
    props.text = props.text.replace('/chart.html', '/new-chart.html')
    props.profile = 'new-profile'
    await settle()
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/fs/download?path=%2Fchart.html&profile=work',
      '/api/fs/download?path=%2Fnew-chart.html&profile=new-profile',
    ])
  })
  it('renders only opted-in directives, retains the iframe and fetch during stream growth, expands and downloads', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('<h1>Chart</h1>'))
    vi.stubGlobal('fetch', fetcher)
    const { host, props } = await mount(false)
    expect(host.querySelector('iframe')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    props.allowPreviews = true; await settle()
    const iframe = host.querySelector('iframe')!
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.hasAttribute('src')).toBe(false)
    expect(iframe.srcdoc).toContain('<h1>Chart</h1>')
    props.text += '\n\nMore streamed **text**.'; await settle()
    expect(host.querySelector('iframe')).toBe(iframe)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(host.querySelector('strong')?.textContent).toBe('text')
    host.querySelector<HTMLButtonElement>('[aria-label="Expand chart.html"]')!.click(); await settle()
    expect(document.querySelector('dialog')?.open).toBe(true)
    expect(document.querySelector('dialog iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    document.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click(); await settle()
    expect(document.querySelector('dialog')).toBeNull()
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('/api/fs/download?path=%2Fchart.html&profile=work')
  })
  it('clears old profile content synchronously, aborts obsolete loads and ignores stale results', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response('<h1>Work</h1>'))
      .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
      .mockImplementationOnce(async () => new Response('<h1>Final</h1>'))
    vi.stubGlobal('fetch', fetcher)
    const { host, props } = await mount()
    expect(host.querySelector('iframe')?.srcdoc).toContain('Work')
    props.profile = 'other'; await nextTick()
    expect(host.querySelector('iframe')).toBeNull()
    props.profile = 'final'; await settle()
    expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(true)
    resolve(new Response('<h1>Stale</h1>')); await settle()
    expect(host.querySelector('iframe')?.srcdoc).toContain('Final')
    expect(host.querySelector('iframe')?.srcdoc).not.toContain('Stale')
  })
  it('shows missing-file retry, ignores foreign messages, clamps child height and never accepts action messages', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response('', { status: 404 }))
      .mockImplementation(async () => new Response('<h1>Retry worked</h1>'))
    vi.stubGlobal('fetch', fetcher)
    const { host } = await mount()
    expect(host.textContent).toContain('unavailable')
    expect(host.querySelector('a[download]')).not.toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="Retry chart.html"]')!.click(); await settle()
    const frame = host.querySelector('iframe')!
    const send = (source: MessageEventSource | null, data: unknown) => window.dispatchEvent(new MessageEvent('message', { source, data }))
    send(window, { type: 'agora-preview-size', height: 700 }); await nextTick()
    expect(frame.style.height).toBe('320px')
    send(frame.contentWindow, { type: 'agora-preview-size', height: 999999 }); await nextTick()
    expect(frame.style.height).toBe('720px')
    send(frame.contentWindow, { type: 'hermes.send', text: 'should never send' }); await nextTick()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})