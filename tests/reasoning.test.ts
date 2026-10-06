import { describe, expect, it } from 'vitest'
import { excludeReplyFromReasoning, reasoningText, restoreReasoning } from '../src/hermes/reasoning'
import { conversationTurns, historyMessages } from '../src/hermes/transcript'

describe('reasoning traces', () => {
  it('keeps a duplicated final answer out of completed reasoning and leaves matching phrases alone', () => {
    const answer = 'Here is the final answer.\n\n- First step\n- Second step'
    expect(excludeReplyFromReasoning('Review the options.\n\n' + answer, answer)).toBe('Review the options.')
    expect(excludeReplyFromReasoning(answer, answer)).toBe('')
    expect(excludeReplyFromReasoning('I expect the answer is yes', 'yes')).toBe('I expect the answer is yes')
    expect(excludeReplyFromReasoning('Unrelated trace', answer)).toBe('Unrelated trace')
    const messages = historyMessages({ session_id: 'a', pagination: { returned: 2, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'assistant', content: answer, reasoning_content: 'Review the options.\n\n' + answer },
      { id: 2, role: 'assistant', content: answer, reasoning_content: answer },
    ] })
    expect(messages[0]?.reasoning?.text).toBe('Review the options.')
    expect(messages[0]?.text).toBe(answer)
    expect(messages[1]?.reasoning).toBeUndefined()
    expect(messages[1]?.text).toBe(answer)
    const restored = restoreReasoning(
      [{ key: 'u', role: 'user', text: 'Question' }, { key: 'reply', role: 'assistant', text: answer }],
      [{ key: 'u', role: 'user', text: 'Question' }, { key: 'live', role: 'assistant', text: answer, reasoning: { text: 'Review the options.\n\n' + answer, active: false } }],
    )
    expect(restored[1]?.reasoning?.text).toBe('Review the options.')
  })

  it('reads only readable provider fields and never exposes replay secrets', () => {
    expect(reasoningText({ reasoning_content: 'Readable text', reasoning: 'Duplicate' })).toBe('Readable text')
    expect(reasoningText({ reasoning_details: [
      { type: 'reasoning.text', text: 'One', signature: 'secret' },
      { type: 'reasoning.encrypted', data: 'encrypted' },
      { type: 'reasoning.summary', summary: 'Two' },
    ] })).toBe('One\n\nTwo')
    expect(reasoningText({ codex_reasoning_items: [{ type: 'reasoning', encrypted_content: 'secret', summary: [{ type: 'summary_text', text: 'Summary' }] }, { type: 'compaction', encrypted_content: 'opaque' }] })).toBe('Summary')
    expect(reasoningText({ reasoning_details: 'encrypted blob' })).toBe('')
  })

  it('shows persisted reasoning-only messages even when the turn has finished', () => {
    const messages = historyMessages({ session_id: 'a', pagination: { returned: 2, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'assistant', content: '', reasoning_content: 'A trace' },
      { id: 2, role: 'assistant', content: 'Answer', reasoning: 'Another trace' },
    ] })
    expect(conversationTurns(messages, false)[0]?.blocks).toHaveLength(2)
    expect(messages[0]?.reasoning).toEqual({ text: 'A trace', active: false })
  })

  it('does not overwrite authoritative history or attach a trace to an ambiguous user prompt', () => {
    const previous = [{ key: 'u', role: 'user', text: 'Question' }, { key: 'r', role: 'assistant', text: 'Answer', reasoning: { text: 'Live trace', active: true } }]
    const history = [{ key: 'row-1', role: 'user', text: 'Question' }, { key: 'row-2', role: 'assistant', text: 'Answer', reasoning: { text: 'Stored trace', active: false } }]
    expect(restoreReasoning(history, previous)[1]?.reasoning?.text).toBe('Stored trace')
    const repeated = [{ key: 'u1', role: 'user', text: 'Question' }, { key: 'u2', role: 'user', text: 'Question' }]
    expect(restoreReasoning(repeated, previous)).toEqual(repeated)
    expect(restoreReasoning([{ key: 'different', role: 'user', text: 'Different prompt' }], previous)).toHaveLength(1)
  })
})
