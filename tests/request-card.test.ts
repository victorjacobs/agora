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

  it('renders a terminal sudo request as masked input with inert command text', () => {
    const { host, answers } = mountRequest({ id: 'sudo-1', method: 'sudo', params: {
      session_id: 'runtime-a', command: 'sudo echo [REDACTED]\n<img src=x onerror=alert(1)>',
    } })
    expect(host.textContent).not.toContain('Unsupported request')
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.querySelector('pre')?.textContent).toBe('sudo echo [REDACTED]\n<img src=x onerror=alert(1)>')
    expect(host.querySelector('img')).toBeNull()
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Submit', 'Cancel'])
    expect(answers).toEqual([])
  })

  it('submits an exact sudo password once and clears it before emitting', async () => {
    const { host, answers } = mountRequest({ id: 'sudo-1', method: 'sudo', params: {} })
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    input.value = '  fictional-password with spaces  '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    submit()
    expect(input.value).toBe('')
    submit()
    await nextTick()
    expect(answers).toEqual([{ value: '  fictional-password with spaces  ' }])
    expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
    expect(host.textContent).not.toContain('fictional-password')
  })

  it('cancels sudo with an empty value and clears the password immediately', async () => {
    const { host, answers } = mountRequest({ id: 'sudo-1', method: 'sudo', params: {} })
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    input.value = 'fictional-cancelled-password'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!
    cancel.click()
    expect(input.value).toBe('')
    cancel.click()
    expect(answers).toEqual([{ value: '' }])
  })

  it.each(['disconnect', 'replacement', 'owner replacement', 'unmount'])('clears sudo DOM and model on %s without answering', async transition => {
    const { host, answers, props } = mountRequest({ id: 'sudo-1', method: 'sudo', params: { session_id: 'runtime-a' } })
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    input.value = 'fictional-lifecycle-password'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    if (transition === 'disconnect') props.disabled = true
    else if (transition === 'replacement') props.request = { id: 'sudo-2', method: 'sudo', params: {} }
    else if (transition === 'owner replacement') props.request = { id: 'sudo-1', method: 'sudo', params: { session_id: 'runtime-b' } }
    else cleanup()
    await nextTick()
    expect(input.value).toBe('')
    expect(answers).toEqual([])
    if (transition === 'disconnect') {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      expect(answers).toEqual([])
      props.disabled = false
      await nextTick()
    }
    const current = host.querySelector<HTMLInputElement>('input[type=password]')
    if (current) {
      expect(current.value).toBe('')
      expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
    }
  })

  it.each(['secret', 'display.install.sudo'])('keeps %s outside terminal sudo support', method => {
    const { host, answers } = mountRequest({ id: 'unsupported', method, params: {} })
    expect(host.textContent).toContain(`Unsupported request: ${method}`)
    expect(host.querySelector('input')).toBeNull()
    expect(answers).toEqual([])
  })

  it('does not submit an empty sudo password or answer while disabled', async () => {
    const { host, answers, props } = mountRequest({ id: 'sudo-1', method: 'sudo', params: {} })
    const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    submit()
    expect(answers).toEqual([])
    props.disabled = true
    await nextTick()
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    input.value = 'fictional-disabled-value'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    submit()
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!
    cancel.click()
    expect(input.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(answers).toEqual([])
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
