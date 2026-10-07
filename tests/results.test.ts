import { describe, expect, it } from 'vitest'
import { resultStatus, resultOutput } from '../src/hermes/results'
import type { HistoryPage } from '../src/hermes/types'

const page = (messages: HistoryPage['messages']): HistoryPage => ({ session_id: 'run', messages, pagination: { offset: 0, returned: messages.length, limit: 50 } })
describe('result evidence', () => {
  it('does not promote reasoning parts or tool-call preambles into output', () => {
    expect(resultOutput(page([{ role: 'assistant', content: [{ type: 'thinking', text: 'Internal thought' }] }]))).toBe('')
    expect(resultOutput(page([{ role: 'assistant', content: 'Calling tool', tool_calls: [{ id: 'call' }] }]))).toBe('')
    expect(resultOutput(page([{ role: 'assistant', content: [{ type: 'thinking', text: 'Internal thought' }, { type: 'text', text: 'Visible answer' }] }]))).toBe('Visible answer')
  })
  it('does not mistake a prior turn for an answer to the latest prompt', () => {
    expect(resultOutput(page([{ role: 'assistant', content: 'Prior answer' }, { role: 'user', content: 'New prompt' }]))).toBe('')
  })
  it('selects the last meaningful assistant answer, excluding tools and delegated artifacts', () => {
    expect(resultOutput(page([
      { id: 1, role: 'assistant', content: 'Intermediate answer' },
      { id: 2, role: 'tool', content: 'Tool secret' },
      { id: 3, role: 'assistant', content: '**Actual final**' },
      { id: 4, role: 'system', content: 'Delegation result', display_kind: 'async_delegation_complete' },
      { id: 5, role: 'assistant', content: '', reasoning_content: 'Private thinking' },
      { id: 6, role: 'assistant', content: 'Hidden', display_kind: 'hidden' },
    ]))).toBe('**Actual final**')
    expect(resultOutput(page([{ role: 'assistant', content: 'Not final', display_kind: 'async_delegation_complete' }]))).toBe('')
  })
  it('uses durable scheduler ownership before legacy activity and never infers success', () => {
    expect(resultStatus({ id: 'owned', scheduler_owned: true, is_active: false })).toBe('Running')
    expect(resultStatus({ id: 'stale', scheduler_owned: false, is_active: true })).toBe('Unknown')
    expect(resultStatus({ id: 'legacy', is_active: true })).toBe('Running')
    expect(resultStatus({ id: 'finished', ended_at: 12 })).toBe('Finished')
    expect(resultStatus({ id: 'unknown' })).toBe('Unknown')
  })
})
