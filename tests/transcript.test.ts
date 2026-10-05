import { describe, expect, it } from 'vitest'
import { conversationTimeline, conversationTurns, historyMessages, mergeHistory, restoreInflight } from '../src/hermes/transcript'
import { renderMarkdown } from '../src/markdown'

describe('transcripts', () => {
  it('keeps task completions between assistant blocks and recovers their place after streaming IDs change', () => {
    const anchor = { key: 'live-reply', role: 'assistant', text: 'First reply' }
    const tasks = [{ key: 'child', goal: 'Check logs', status: 'failed', completedAfter: anchor }]
    const messages = [anchor, { key: 'second', role: 'assistant', text: 'Follow-up reply' }]
    expect(conversationTimeline(messages, tasks, false).map(item => item.kind)).toEqual(['turn', 'tasks', 'turn'])
    const recovered = [{ ...anchor, key: 'row-1', rowId: 1 }, messages[1]!]
    const timeline = conversationTimeline(recovered, tasks, false)
    expect(timeline.map(item => item.kind)).toEqual(['turn', 'tasks', 'turn'])
    expect(timeline[0]?.key).toBe('row-1')
    expect(timeline[2]?.key).toBe('second')
    expect(conversationTimeline(messages, [{ ...tasks[0]!, status: 'running' }], false).map(item => item.kind)).toEqual(['turn'])
  })
  it('groups tool rows across empty assistant messages without changing their order or crossing user turns', () => {
    const messages = historyMessages({ session_id: 'stored', pagination: { returned: 8, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', content: 'Question' },
      { id: 2, role: 'assistant', content: '' },
      { id: 3, role: 'tool', tool_name: 'terminal', content: 'First output' },
      { id: 4, role: 'assistant', content: ' ' },
      { id: 5, role: 'tool', tool_name: 'read_file', content: 'Second output' },
      { id: 6, role: 'assistant', content: 'Answer' },
      { id: 7, role: 'user', content: 'Next question' },
      { id: 8, role: 'assistant', content: 'Next answer' },
    ] })
    const turns = conversationTurns(messages, false)
    expect(turns.map(turn => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const tools = turns[1].blocks[0]
    expect(tools.kind).toBe('tools')
    if (tools.kind !== 'tools') throw new Error('Expected grouped tools')
    expect(tools.messages.map(message => [message.name, message.text])).toEqual([['terminal', 'First output'], ['read_file', 'Second output']])
    expect(turns[1].blocks[1].kind).toBe('text')
    expect(messages).toHaveLength(8)
  })

  it('keeps text on both sides of tools and only shows an empty assistant when streaming', () => {
    const messages = [
      { key: 'a', role: 'assistant', text: 'Checking…' },
      { key: 't', role: 'tool', text: 'Output' },
      { key: 'b', role: 'assistant', text: 'Result' },
      { key: 'live', role: 'assistant', text: '' },
    ]
    expect(conversationTurns(messages, false)[0].blocks.map(block => block.kind)).toEqual(['text', 'tools', 'text'])
    expect(conversationTurns(messages, true)[0].blocks.map(block => block.kind)).toEqual(['text', 'tools', 'text', 'text'])
    expect(conversationTurns([{ key: 'empty', role: 'assistant', text: '' }], false)).toEqual([])
  })

  it('uses durable row IDs, respects projections, and merges overlapping pages', () => {
    const page = historyMessages({ session_id: 'stored', pagination: { returned: 4, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', content: 'private scaffolding', display_kind: 'hidden' },
      { id: 2, role: 'user', content: 'model wrapper', display_content: 'actual question' },
      { id: 3, role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ] })
    expect(page.map(message => message.text)).toEqual(['actual question', 'answer'])
    expect(mergeHistory(page, page)).toHaveLength(2)
  })

  it('restores the active assistant without duplicating the persisted user', () => {
    const messages = [{ key: 'row-1', rowId: 1, role: 'user', text: 'question' }]
    const recovered = restoreInflight(messages, { session_id: 'runtime', info: {}, running: true, inflight: { user: 'question', assistant: 'partial' } })
    expect(recovered.map(message => message.text)).toEqual(['question', 'partial'])
    expect(restoreInflight(recovered, { session_id: 'runtime', info: {}, running: true, inflight: { user: 'question', assistant: 'partial' } })).toEqual(recovered)
  })

  it('renders Markdown and code without executing HTML or loading remote images', () => {
    const rendered = renderMarkdown('**bold**\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![tracking](https://example.test/image.png)')
    expect(rendered).toContain('<strong>bold</strong>')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).not.toMatch(/<script|<img|href="javascript:/)
  })
})
