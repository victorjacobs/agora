import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import App from '../src/App.vue'
import { ChatClient } from '../src/hermes/chat'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mountApp() {
  let client!: ChatClient
  vi.spyOn(ChatClient.prototype, 'start').mockImplementation(async function (this: ChatClient) {
    client = this
    Object.assign(this.state, {
      connection: 'ready', selected: 'stored', runtime: 'runtime',
      title: 'Synthetic conversation', profile: 'work',
    })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App)
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, client }
}

describe('chat interface', () => {
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
