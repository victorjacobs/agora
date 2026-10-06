import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import App from '../src/App.vue'
import { ChatClient } from '../src/hermes/chat'
import { HermesApi } from '../src/hermes/api'
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
  it('switches to memory without losing the chat draft and reviews inline changes explicitly', async () => {
    const pending = vi.spyOn(ChatClient.prototype, 'pendingMemory').mockResolvedValue({ previews: [{ id: 'abcdef01', summary: 'Truncated preview', background: true, targetDetails: '' }] })
    const approve = vi.spyOn(ChatClient.prototype, 'approve').mockResolvedValue()
    const { host, client } = mountApp()
    client.state.draft = 'An unsent message'
    client.state.approvals = [{ request_id: 'memory-one', description: 'Save to memory: add to user profile', command: 'I prefer concise answers.\n<img src=x onerror=alert(1)>', choices: ['once', 'deny'] }]
    await nextTick()
    expect(pending).not.toHaveBeenCalled()
    expect(host.querySelector('.app-rail .rail-badge')?.textContent).toBe('1')
    host.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!.click()
    await vi.waitFor(() => expect(host.querySelector('.memory-preview')?.textContent).toContain('Truncated preview'))
    expect(pending).toHaveBeenCalledWith('runtime', 'work')
    expect(host.querySelector('[aria-label="Session history"]')).toBeNull()
    expect(host.querySelector('[aria-label="Search chats"]')).toBeNull()
    expect(host.querySelector('[aria-label="New chat"]')).toBeNull()
    expect(host.querySelector('[aria-label="Memory sections"]')?.textContent).toContain('Pending updates')
    const memory = host.querySelector('.memory-view')!
    expect(memory.querySelector('.memory-proposal')?.textContent).toContain('I prefer concise answers.')
    expect(memory.querySelector('img')).toBeNull()
    expect(memory.querySelector('.memory-preview button')).toBeNull()
    expect(approve).not.toHaveBeenCalled()
    memory.querySelector<HTMLButtonElement>('.memory-actions .primary')!.click()
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'memory-one' }), 'once')
    host.querySelector<HTMLButtonElement>('[aria-label="Chat"]')!.click()
    await nextTick()
    expect(client.state.draft).toBe('An unsent message')
    expect(host.querySelector('[aria-label="Session history"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Memory sections"]')).toBeNull()
    expect(host.querySelector<HTMLElement>('.memory-view')?.style.display).toBe('none')
  })

  it('routes memory decisions through the original server request and drops stale profile previews', async () => {
    let resolve!: (value: { previews: [] }) => void
    const pending = vi.spyOn(ChatClient.prototype, 'pendingMemory').mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ previews: [{ id: '12345678', summary: 'Personal preview', background: false, targetDetails: '' }] })
    const answer = vi.spyOn(ChatClient.prototype, 'answer').mockResolvedValue()
    const approve = vi.spyOn(ChatClient.prototype, 'approve').mockResolvedValue()
    const { host, client } = mountApp()
    const approval = { request_id: 'memory-one', description: 'Save to memory: add to memory', command: 'Complete proposed change', choices: ['once', 'deny'] }
    client.state.approvals = [approval]
    client.state.requests = [{ id: 'server-request', method: 'approval', params: { ...approval, session_id: 'runtime' } }]
    await nextTick()
    host.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!.click()
    await nextTick()
    expect(host.querySelectorAll('.memory-view .memory-approval')).toHaveLength(1)
    host.querySelector<HTMLButtonElement>('.memory-view .memory-actions button')!.click()
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-request' }), { choice: 'deny' })
    expect(approve).not.toHaveBeenCalled()
    client.state.profile = 'personal'
    await vi.waitFor(() => expect(host.querySelector('.memory-preview')?.textContent).toContain('Personal preview'))
    expect(pending).toHaveBeenLastCalledWith('runtime', 'personal')
    resolve({ previews: [] })
    await nextTick()
    expect(host.querySelector('.memory-preview')?.textContent).toContain('Personal preview')
  })

  it('shows running calls and their details in the expandable tool group', async () => {
    const { host, client } = mountApp()
    client.state.running = true
    client.state.messages = [
      { key: 'user', role: 'user', text: 'Check the project' },
      { key: 'first', role: 'tool', name: 'read_file', text: 'Read README', tool: { id: 'one', status: 'completed', duration: 0.2 } },
      { key: 'second', role: 'tool', name: 'terminal', text: '', tool: { id: 'two', status: 'running', context: 'npm test <img src=x>', args: '{"command":"npm test"}' } },
    ]
    await nextTick()
    const group = host.querySelector<HTMLDetailsElement>('.tool-group')!
    expect(group.querySelector('summary')?.textContent).toContain('2 tool calls')
    expect(group.querySelector('summary')?.textContent).toContain('1 running')
    expect(group.querySelector('summary')?.textContent).toContain('terminal · npm test')
    expect(group.querySelector('.tool-spinner')).not.toBeNull()
    expect(group.querySelector('img')).toBeNull()
    expect(host.querySelector('.thinking')).toBeNull()
    expect(host.querySelector('.activity .pulse')).not.toBeNull()
    expect(host.querySelector('.activity')?.textContent).toContain('Working…')
    group.open = true
    expect(group.querySelector('.tool-arguments pre')?.textContent).toContain('npm test')
    expect(group.textContent).toContain('Waiting for output…')
    client.state.messages[2]!.tool!.status = 'completed'
    client.state.messages[2]!.text = 'Tests passed'
    await nextTick()
    expect(group.open).toBe(true)
    expect(group.querySelector('.tool-spinner')).toBeNull()
    expect(group.textContent).toContain('Tests passed')
    expect(group.textContent).toContain('Completed · 0.2s')
    expect(host.querySelector('.activity .pulse')).not.toBeNull()
    client.state.running = false
    await nextTick()
    expect(host.querySelector('.activity')).toBeNull()
  })

  it('switches conversations with Command/Ctrl K and restores the previous search and draft on close', async () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value() { this.setAttribute('open', '') } },
      close: { configurable: true, value() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } },
    })
    const { host, client } = mountApp()
    const unmount = cleanup
    cleanup = () => {
      unmount()
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
    }
    client.state.sessions = [{ id: 'first', title: 'Deployment notes', profile: 'work' }, { id: 'second', title: 'Garden plans', profile: 'work' }]
    client.state.draft = 'Unsent question'
    client.state.searchQuery = 'deployment'
    const search = vi.spyOn(client, 'searchConversations').mockImplementation(query => { client.state.searchQuery = query })
    const open = vi.spyOn(client, 'open').mockResolvedValue()
    await nextTick()
    const composer = host.querySelector<HTMLTextAreaElement>('textarea')!
    composer.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }))
    await nextTick()
    const palette = host.querySelector<HTMLDialogElement>('.conversation-switcher')!
    const input = palette.querySelector<HTMLInputElement>('input')!
    expect(palette.open).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(2)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    expect(input.getAttribute('aria-activedescendant')).toBe('switcher-option-1')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(open).toHaveBeenCalledWith('second', 'work')
    expect(palette.open).toBe(false)
    expect(search).toHaveBeenLastCalledWith('deployment')
    expect(document.activeElement).toBe(composer)
    expect(client.state.draft).toBe('Unsent question')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }))
    await nextTick()
    input.value = 'garden'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(palette.textContent).toContain('Garden plans')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }))
    await nextTick()
    expect(palette.open).toBe(false)
    expect(client.state.searchQuery).toBe('deployment')
  })
  it('pins only running tasks and leaves finished tasks before subsequent messages', async () => {
    const { host, client } = mountApp()
    client.state.messages = [{ key: 'reply', role: 'assistant', text: 'Initial reply' }]
    client.state.tasks = [{ key: 'child', goal: 'Check logs', status: 'running' }]
    await nextTick()
    expect(host.querySelector('.pinned-tasks')?.textContent).toContain('Check logs')
    expect(host.querySelector('.transcript .background-tasks')).toBeNull()
    client.state.tasks = [{ ...client.state.tasks[0]!, status: 'completed', completedAfter: { ...client.state.messages[0]! } }]
    client.state.messages.push({ key: 'question', role: 'user', text: 'Next question' })
    await nextTick()
    expect(host.querySelector('.pinned-tasks')).toBeNull()
    const transcript = host.querySelector('.transcript')!
    expect(transcript.textContent!.indexOf('Initial reply')).toBeLessThan(transcript.textContent!.indexOf('Check logs'))
    expect(transcript.textContent!.indexOf('Check logs')).toBeLessThan(transcript.textContent!.indexOf('Next question'))
    expect(host.querySelectorAll('.background-tasks')).toHaveLength(1)
  })
  it('exposes model and reasoning choices and asks before confirming a guarded model switch', async () => {
    const { host, client } = mountApp()
    Object.assign(client.state, {
      model: 'first', provider: 'configured', reasoning: 'medium',
      modelProviders: [{ slug: 'configured', name: 'Configured', models: ['first', 'second'], capabilities: { first: { reasoning: true, can_disable_reasoning: false } } }],
    })
    const model = vi.spyOn(client, 'chooseModel').mockResolvedValue()
    const reasoning = vi.spyOn(client, 'chooseReasoning').mockResolvedValue()
    await nextTick()
    const modelSelect = host.querySelector<HTMLSelectElement>('[aria-label="Model"]')!
    const reasoningSelect = host.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')!
    expect(modelSelect.value).toBe(JSON.stringify(['configured', 'first']))
    expect(reasoningSelect.querySelector<HTMLOptionElement>('option[value="none"]')?.disabled).toBe(true)
    modelSelect.value = JSON.stringify(['configured', 'second'])
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(model).toHaveBeenCalledWith({ model: 'second', provider: 'configured' })
    reasoningSelect.value = 'high'
    reasoningSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(reasoning).toHaveBeenCalledWith('high')
    client.state.modelConfirmation = { model: 'second', provider: 'configured', message: 'This model costs more.' }
    await nextTick()
    expect(host.querySelector('.settings-confirmation')?.textContent).toContain('costs more')
    expect(model).toHaveBeenCalledTimes(1)
    host.querySelector<HTMLButtonElement>('.settings-confirmation button')!.click()
    expect(model).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'second', provider: 'configured' }), true)
    client.state.modelConfirmation = undefined
    client.state.running = true
    await nextTick()
    expect(modelSelect.disabled).toBe(true)
    expect(reasoningSelect.disabled).toBe(true)
  })

  it('filters chat titles, opens search results, and clears search on Escape', async () => {
    const { host, client } = mountApp()
    client.state.sessions = [{ id: 'one', title: 'Deployment notes', profile: 'work' }, { id: 'two', title: 'Garden plans', profile: 'work' }]
    const search = vi.spyOn(client, 'searchConversations').mockImplementation(query => { client.state.searchQuery = query })
    const open = vi.spyOn(client, 'open').mockResolvedValue()
    await nextTick()
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!
    input.value = 'deploy'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(search).toHaveBeenCalledWith('deploy')
    expect([...host.querySelectorAll('.session-title')].map(element => element.textContent)).toEqual(['Deployment notes'])
    host.querySelector<HTMLButtonElement>('.session')!.click()
    expect(open).toHaveBeenCalledWith('one', 'work')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(search).toHaveBeenLastCalledWith('')
    expect(host.querySelectorAll('.session')).toHaveLength(2)
  })

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

  it('renders generated tool images inline and preserves previews during streaming updates', async () => {
    const request = vi.spyOn(HermesApi.prototype, 'request').mockResolvedValue({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
    const { host, client } = mountApp()
    client.state.messages = [{ key: 'image-tool', role: 'tool', name: 'image_generate', text: JSON.stringify({ success: true, image: '/home/hermes/images/cat.png' }) }]
    await vi.waitFor(() => expect(host.querySelector('.markdown img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8='))
    expect(host.querySelector('details')?.open).toBe(false)
    expect(host.querySelector('details img')).toBeNull()
    client.state.messages.push({ key: 'reply', role: 'assistant', text: 'Here is the image.' })
    await nextTick()
    expect(host.querySelector('.markdown img')).not.toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('renders live MEDIA images and reloads them when the profile changes', async () => {
    const request = vi.spyOn(HermesApi.prototype, 'request').mockResolvedValue({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
    const { host, client } = mountApp()
    client.state.profile = 'work'
    client.state.messages = [{ key: 'media-reply', role: 'assistant', text: 'Here is the chart.\nMEDIA:\n/workspace/chart.png' }]
    await vi.waitFor(() => expect(host.querySelector('.markdown img')).not.toBeNull())
    expect(request).toHaveBeenLastCalledWith('/api/fs/read-data-url?path=%2Fworkspace%2Fchart.png&profile=work')
    client.state.profile = 'personal'
    await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('/api/fs/read-data-url?path=%2Fworkspace%2Fchart.png&profile=personal'))
    await vi.waitFor(() => expect(host.querySelector('.markdown img')).not.toBeNull())
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shows tasks while the main turn is idle and renders task data safely', async () => {
    const { host, client } = mountApp()
    client.state.tasks = [{ key: 'child', goal: 'Check logs <img src=x>', status: 'running', model: 'Hermes model', toolCount: 2, tool: 'terminal' }]
    await nextTick()
    const panel = host.querySelector('[aria-label="Background tasks"]')!
    expect(panel.textContent).toContain('Check logs <img src=x>')
    expect(panel.textContent).toContain('2 tool calls')
    expect(panel.querySelector('img')).toBeNull()
    expect(panel.textContent).toContain('1 running')
    client.state.tasks = [{ key: 'child', goal: 'Check logs', status: 'failed', summary: '<script>danger()</script>' }]
    client.state.messages = [{ key: 'notice', role: 'user', kind: 'async_delegation_complete', text: 'Result evidence', metadata: { display_text: 'Logs checked', task_count: 1, completed_count: 0, failed_count: 1 } }]
    await nextTick()
    const finishedPanel = host.querySelector('.transcript [aria-label="Background tasks"]')!
    expect(host.querySelector('.pinned-tasks')).toBeNull()
    expect(finishedPanel.textContent).toContain('Failed')
    expect(finishedPanel.querySelector('details:not(.task-description)')?.textContent).toContain('<script>danger()</script>')
    expect(finishedPanel.querySelector('script')).toBeNull()
    expect(host.querySelector('.message-author')).toBeNull()
    expect(host.querySelector('.task-result-title')?.textContent).toBe('Logs checked')
    expect(host.querySelector('.task-result')?.textContent).toContain('1 task · 0 completed · 1 failed')
  })

  it('labels user and assistant turns without avatars and keeps tool output grouped safely', async () => {
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
    expect(host.querySelector('.message.user')?.getAttribute('aria-label')).toBe('You')
    expect(host.querySelector('.message.assistant')?.getAttribute('aria-label')).toBe('Hermes')
    expect(host.querySelector('.avatar, .message-author')).toBeNull()
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
    await vi.waitFor(() => expect(host.querySelector('.session-title')?.textContent).toBe('Synthetic conversation'))
    expect(host.querySelector('.connection-status')).toBeNull()
    expect(host.textContent).not.toContain('Synthetic operator')
    expect(host.textContent).not.toContain('https://remote-hermes.test')
    expect(host.querySelector('.session-title')?.textContent).toBe('Synthetic conversation')
    expect(host.querySelector('.sign-in-page')).toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).toBeNull()
    expect(host.querySelector('.provider-quota')).not.toBeNull()
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
    expect(host.querySelector('.startup-page [role="status"]')?.textContent).toContain('Loading…')
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
    expect(host.textContent).not.toContain('https://remote-hermes.test')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic connection failure')
    const retry = vi.spyOn(client, 'connect').mockResolvedValue()
    host.querySelector<HTMLButtonElement>('.sign-in-error button')!.click()
    expect(retry).toHaveBeenCalledOnce()
    expect(host.querySelector('form[action="/auth/logout"]')).toBeNull()
    client.state.identity = 'Synthetic operator'
    await nextTick()
    expect(login()).toBeNull()
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(host.querySelector('form[action="/auth/logout"]')).toBeNull()
    expect(host.querySelector('.provider-quota')).not.toBeNull()
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
