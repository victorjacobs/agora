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
  it('shows an accessible unread-response indicator in the conversation list', async () => {
    const { host, client } = mountApp()
    client.state.sessions = [{ id: 'other', title: 'Other conversation', profile: 'work' }]
    client.state.unreadReplies = [{ id: 'other', profile: 'work' }]
    await nextTick()
    expect(host.querySelector('.session [aria-label="Unread response"]')).not.toBeNull()
    client.state.unreadReplies = []
    await nextTick()
    expect(host.querySelector('.unread-reply')).toBeNull()
  })

  it('shows tasks while the main turn is idle and renders task data safely', async () => {
    const { host, client } = mountApp()
    client.state.tasks = [{ key: 'child', goal: 'Check logs <img src=x>', status: 'running', model: 'Hermes model', toolCount: 2, tool: 'terminal' }]
    await nextTick()
    const panel = host.querySelector('[aria-label="Background tasks"]')!
    expect(panel.textContent).toContain('Check logs <img src=x>')
    expect(panel.textContent).toContain('2 tool calls')
    expect(panel.querySelector('img')).toBeNull()
    expect(host.querySelector('.connection-status')?.textContent).toContain('1 background task running')
    client.state.tasks = [{ key: 'child', goal: 'Check logs', status: 'failed', summary: '<script>danger()</script>' }]
    client.state.messages = [{ key: 'notice', role: 'user', kind: 'async_delegation_complete', text: 'Result evidence', metadata: { display_text: 'Logs checked', task_count: 1, completed_count: 0, failed_count: 1 } }]
    await nextTick()
    expect(panel.textContent).toContain('Failed')
    expect(panel.querySelector('details')?.textContent).toContain('<script>danger()</script>')
    expect(panel.querySelector('script')).toBeNull()
    expect(host.querySelector('.message-author')).toBeNull()
    expect(host.querySelector('.task-result summary')?.textContent).toBe('Logs checked')
    expect(host.querySelector('.task-result')?.textContent).toContain('1 task · 0 completed · 1 failed')
  })

  it('shows one assistant header and a compact expandable tool group with safe output', async () => {
    const { host, client } = mountApp()
    client.state.messages = [
      { key: 'user', role: 'user', text: 'Question' },
      { key: 'empty-1', role: 'assistant', text: '' },
      { key: 'tool-1', role: 'tool', name: 'terminal', text: '<img src=x onerror=alert(1)>' },
      { key: 'empty-2', role: 'assistant', text: '' },
      { key: 'tool-2', role: 'tool', name: 'read_file', text: 'File contents' },
      { key: 'answer', role: 'assistant', text: 'Answer' },
    ]
    await nextTick()
    expect(host.querySelectorAll('.assistant .message-author')).toHaveLength(1)
    const group = host.querySelector<HTMLDetailsElement>('.tool-group')!
    expect(group.open).toBe(false)
    expect(group.querySelector('summary')?.textContent).toContain('2 tool calls')
    expect(group.querySelectorAll('.tool-output')).toHaveLength(2)
    expect(group.querySelector('pre')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(group.querySelector('img')).toBeNull()
    group.open = true
    client.state.messages.at(-1)!.text += ' updated'
    await nextTick()
    expect(host.querySelector('.tool-group')).toBe(group)
    expect(group.open).toBe(true)
  })

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
    expect(host.querySelector('.sign-in-page')).toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).not.toBeNull()
  })

  it('goes directly from the session check to chat for an authenticated refresh', async () => {
    const { host, client } = mountApp('connecting')
    await nextTick()
    expect(host.querySelector('.startup-page')).not.toBeNull()
    expect(host.querySelector('.sign-in-page')).toBeNull()
    client.state.identity = 'Signed-in operator'
    client.state.connection = 'recovering'
    await nextTick()
    expect(host.querySelector('.startup-page')).toBeNull()
    expect(host.querySelector('.sign-in-page')).toBeNull()
    expect(host.querySelector('.shell')).not.toBeNull()
    client.state.connection = 'ready'
    await nextTick()
    expect(host.querySelector('.sign-in-page')).toBeNull()
  })

  it('shows a neutral startup screen until the session check finishes', async () => {
    const { host, client } = mountApp('connecting')
    await nextTick()
    const login = () => host.querySelector<HTMLAnchorElement>('.sign-in-button')
    expect(login()).toBeNull()
    expect(host.querySelector('.sign-in-page')).toBeNull()
    expect(host.querySelector('.startup-page [role="status"]')?.textContent).toContain('Connecting to Hermes')
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelector('.sidebar')).toBeNull()
    client.state.endpoint = 'https://remote-hermes.test'
    client.state.authRequired = true
    client.state.connection = 'failed'
    client.state.error = 'Synthetic connection failure'
    await nextTick()
    expect(login()?.textContent).toContain('Sign in with Hermes')
    expect(new URL(login()!.href).searchParams.get('next')).toBe(window.location.pathname + window.location.search)
    expect(host.querySelector('.startup-page')).toBeNull()
    expect(host.querySelector('.server-address')?.textContent).toBe('https://remote-hermes.test')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic connection failure')
    const retry = vi.spyOn(client, 'connect').mockResolvedValue()
    host.querySelector<HTMLButtonElement>('.sign-in-error button')!.click()
    expect(retry).toHaveBeenCalledOnce()
    expect(host.querySelector('form[action="/auth/logout"]')).toBeNull()
    client.state.identity = 'Synthetic operator'
    await nextTick()
    expect(login()).toBeNull()
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).not.toBeNull()
    client.state.connection = 'reconnecting'
    await nextTick()
    expect(host.querySelector('.sign-in-page')).toBeNull()
    client.state.connection = 'expired'
    client.state.identity = ''
    await nextTick()
    expect(login()).not.toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelector('.session-list')).toBeNull()
  })

  it('sends on Enter, preserves Shift+Enter, and does not submit while running', async () => {
    const { host, client } = mountApp()
    const send = vi.spyOn(client, 'send').mockResolvedValue()
    await nextTick()
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!
    input.value = 'synthetic question'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    expect(send).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledOnce()
    client.state.sessions = [{ id: 'stored', profile: 'work', title: 'Synthetic conversation' }]
    client.state.running = true
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Stop')
    expect(host.querySelector('.session-indicator')?.getAttribute('aria-label')).toBe('Running')
    client.state.approvals = [{ request_id: 'pending' }]
    await nextTick()
    expect(host.querySelector('.session-indicator.waiting')?.getAttribute('aria-label')).toBe('Waiting for input')
    client.state.running = false
    await nextTick()
    expect(host.querySelector('.session-indicator')).toBeNull()
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
