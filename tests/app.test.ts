import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import App from '../src/App.vue'
import { ChatClient } from '../src/hermes/chat'
import { Gateway } from '../src/hermes/gateway'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

function renderApp() {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App)
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

function mountApp(connection: 'ready' | 'connecting' = 'ready') {
  let client!: ChatClient
  vi.spyOn(ChatClient.prototype, 'start').mockImplementation(async function (this: ChatClient) {
    client = this
    Object.assign(this.state, {
      connection, selected: 'stored', runtime: 'runtime',
      title: 'Synthetic conversation', profile: 'work',
    })
  })
  const host = renderApp()
  return { host, client }
}

describe('chat interface', () => {
  it('connects and loads conversations after login using the real client startup', async () => {
    vi.stubGlobal('fetch', vi.fn(function (this: unknown, path: string) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      let result: unknown
      if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://remote-hermes.test' }
      else if (path === '/api/status') result = { auth_required: true }
      else if (path === '/api/auth/me') result = { display_name: 'Synthetic operator' }
      else if (path.startsWith('/api/sessions?')) result = { sessions: [{ id: 'stored', title: 'Synthetic conversation' }], total: 1 }
      else throw new Error(`Unexpected API request: ${path}`)
      return Promise.resolve(new Response(JSON.stringify(result)))
    }))
    vi.spyOn(Gateway.prototype, 'connect').mockResolvedValue()
    vi.spyOn(Gateway.prototype, 'request').mockResolvedValue({})
    const host = renderApp()
    await vi.waitFor(() => expect(host.querySelector('.connection-status')?.textContent).toBe('Connected'))
    expect(host.querySelector('.identity')?.textContent).toContain('Synthetic operator')
    expect(host.querySelector('.session-title')?.textContent).toBe('Synthetic conversation')
    expect(host.querySelector('.conversation-header a[href^="/login?"]')).toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).not.toBeNull()
  })

  it('offers sign-in before the server responds and during connection failures', async () => {
    const { host, client } = mountApp('connecting')
    await nextTick()
    const login = () => host.querySelector<HTMLAnchorElement>('.conversation-header a[href^="/login?"]')
    expect(login()?.textContent).toBe('Sign in with Hermes')
    expect(new URL(login()!.href).searchParams.get('next')).toBe(window.location.pathname + window.location.search)
    client.state.authRequired = true
    client.state.connection = 'failed'
    await nextTick()
    expect(login()).not.toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).toBeNull()
    client.state.identity = 'Synthetic operator'
    await nextTick()
    expect(login()).toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).not.toBeNull()
  })

  it('sends on Enter, preserves Shift+Enter, and does not submit while running', async () => {
    const { host, client } = mountApp()
    const send = vi.spyOn(client, 'send').mockResolvedValue()
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!
    input.value = 'synthetic question'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    expect(send).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledOnce()
    client.state.running = true
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Stop')
  })

  it('keeps a reader at their scroll position and offers a jump to latest', async () => {
    const { host, client } = mountApp()
    await nextTick()
    const transcript = host.querySelector<HTMLElement>('.transcript')!
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { value: 400 } })
    transcript.scrollTop = 200
    transcript.dispatchEvent(new Event('scroll'))
    client.state.messages.push({ key: 'row-1', role: 'assistant', text: 'new answer' })
    await nextTick()
    expect(transcript.scrollTop).toBe(200)
    const jump = host.querySelector<HTMLButtonElement>('.jump-latest')!
    expect(jump.textContent).toContain('Latest messages')
    jump.click()
    await nextTick()
    expect(transcript.scrollTop).toBe(1500)
  })
})
