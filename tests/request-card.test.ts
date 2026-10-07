import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import RequestCard from '../src/RequestCard.vue'
import type { ServerRequest } from '../src/hermes/types'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mountRequest(request: ServerRequest, disabled = false) {
  const answers: Record<string, unknown>[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const props = reactive({ request, disabled })
  const app = createApp({ render: () => h(RequestCard, { ...props, onAnswer: (answer: Record<string, unknown>) => answers.push(answer) }) })
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, answers, props }
}

describe('request controls', () => {
  it('offers only the server choices and never answers on mount', async () => {
    const { host, answers } = mountRequest({ id: 'req', method: 'approval', params: { choices: ['once', 'deny'], command: 'echo synthetic' } })
    expect(answers).toEqual([])
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Reject', 'Allow once'])
    ;(host.querySelector('button.primary') as HTMLButtonElement).click()
    await nextTick()
    expect(answers).toEqual([{ choice: 'once' }])
  })

  it('shows command text safely and separates remembered approval choices', async () => {
    const { host, answers } = mountRequest({ id: 'req', method: 'approval', params: {
      choices: ['once', 'session', 'always', 'deny'], description: 'Deletes project files',
      command: 'rm -rf build\n<img src=x onerror=alert(1)>',
    } })
    expect(host.querySelector('pre')?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('details')?.textContent).toContain('Remember approval for matching commands')
    expect(answers).toEqual([])
    const session = [...host.querySelectorAll('details button')].find(button => button.textContent === 'Allow for this conversation') as HTMLButtonElement
    session.click()
    await nextTick()
    expect(answers).toEqual([{ choice: 'session' }])
  })

  it('does not allow a command with no reviewable text or invent remembered choices', () => {
    const { host, answers } = mountRequest({ id: 'req', method: 'approval', params: { description: 'A command needs approval' } })
    expect(host.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true)
    expect(host.querySelector('details')).toBeNull()
    expect(answers).toEqual([])
    host.querySelector<HTMLButtonElement>('button')!.click()
    expect(answers).toEqual([{ choice: 'deny' }])
  })

  it('sends multi-select and free-text clarification answers with original qids', async () => {
    const { host, answers } = mountRequest({ id: 'req', method: 'clarify', params: {
      questions: [{ qid: 'q1', question: 'Which?', choices: ['One', 'Two'], multi_select: true }, { qid: 'q2', question: 'Why?' }],
    } })
    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    checkboxes[0].click()
    await nextTick()
    checkboxes[1].click()
    const text = host.querySelectorAll<HTMLInputElement>('input[type=text]')[1]
    text.value = 'Because'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false)
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(answers).toEqual([{ answers: { q1: 'One, Two', q2: 'Because' } }])
  })

  it('saves a login through the masked vault request without adding chat text', async () => {
    const { host, answers } = mountRequest({ id: 'login', method: 'vault.save_login', params: { site: 'Example', origin: 'https://example.com' } })
    expect(host.textContent).toContain('https://example.com')
    expect(answers).toEqual([])
    const identifier = host.querySelector<HTMLInputElement>('input[autocomplete=username]')!
    const password = host.querySelector<HTMLInputElement>('input[type=password]')!
    expect(password).not.toBeNull()
    identifier.value = 'synthetic-user'
    identifier.dispatchEvent(new Event('input', { bubbles: true }))
    password.value = 'synthetic-password'
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(answers).toEqual([{ value: JSON.stringify({ identifier: 'synthetic-user', password: 'synthetic-password' }) }])
    expect(password.value).toBe('')
    expect(host.textContent).not.toContain('synthetic-password')
  })

  it.each(['vault.unlock_prompt', 'vault.code'])('answers %s with a masked value and explicit cancellation', async method => {
    const { host, answers } = mountRequest({ id: 'secure', method, params: { display_name: 'Bitwarden', site: 'Example', hint: 'Read your authenticator' } })
    expect(answers).toEqual([])
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    expect(input).not.toBeNull()
    input.value = 'synthetic-value'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(answers).toEqual([{ value: 'synthetic-value' }])
    expect(input.value).toBe('')
    expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
    cleanup()
    const cancelled = mountRequest({ id: 'cancel', method, params: {} })
    ;([...cancelled.host.querySelectorAll('button')].find(button => button.textContent === 'Cancel') as HTMLButtonElement).click()
    expect(cancelled.answers).toEqual([{ value: '' }])
  })

  it('clears secure input when disconnected or replaced and never submits while disabled', async () => {
    const { host, answers, props } = mountRequest({ id: 'secure', method: 'vault.code', params: {} })
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    input.value = 'synthetic-code'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    props.disabled = true
    await nextTick()
    expect(input.value).toBe('')
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(answers).toEqual([])
    props.disabled = false
    await nextTick()
    input.value = 'synthetic-code'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    props.request = { id: 'replacement', method: 'vault.code', params: {} }
    await nextTick()
    expect(host.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
    expect(answers).toEqual([])
  })

  it('shows unsupported interactions explicitly and disables supported actions while recovering', () => {
    const unsupported = mountRequest({ id: 'req', method: 'vault.future', params: {} })
    expect(unsupported.host.textContent).toContain('Unsupported request: vault.future')
    expect(unsupported.answers).toHaveLength(0)
    cleanup()
    const recovering = mountRequest({ id: 'req', method: 'approval', params: { choices: ['once', 'deny'] } }, true)
    expect([...recovering.host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
  })
})
