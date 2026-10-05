import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import RequestCard from '../src/RequestCard.vue'
import type { ServerRequest } from '../src/hermes/types'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mountRequest(request: ServerRequest, disabled = false) {
  const answers: Record<string, unknown>[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(RequestCard, { request, disabled, onAnswer: (answer: Record<string, unknown>) => answers.push(answer) })
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, answers }
}

describe('request controls', () => {
  it('offers only the server choices and never answers on mount', async () => {
    const { host, answers } = mountRequest({ id: 'req', method: 'approval', params: { choices: ['once', 'deny'], command: 'echo synthetic' } })
    expect(answers).toEqual([])
    expect([...host.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow once', 'Deny'])
    ;(host.querySelector('button') as HTMLButtonElement).click()
    await nextTick()
    expect(answers).toEqual([{ choice: 'once' }])
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

  it('shows unsupported interactions explicitly and disables supported actions while recovering', () => {
    const unsupported = mountRequest({ id: 'req', method: 'vault.code', params: {} })
    expect(unsupported.host.textContent).toContain('Unsupported request: vault.code')
    expect(unsupported.answers).toHaveLength(0)
    cleanup()
    const recovering = mountRequest({ id: 'req', method: 'approval', params: { choices: ['once', 'deny'] } }, true)
    expect([...recovering.host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
  })
})
