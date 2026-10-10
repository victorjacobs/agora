import { describe, expect, it } from 'vitest'
import { conversationTimeline, conversationTurns, historyMessages, mergeHistory, restoreInflight } from '../src/hermes/transcript'
import { renderMarkdown } from '../src/markdown'
import { anchorFinishedTasks } from '../src/hermes/tasks'

describe('transcripts', () => {
  it.each([
    ['single context', '[ASYNC DELEGATION COMPLETE — batch]\nContext you provided: quoted notice\n--- RESULT ---\nClient-only result\nRole: leaf   Model: ?\n--- RESULT ---\nActual result omitted'],
    ['single output', '[ASYNC DELEGATION COMPLETE — batch]\nRole: leaf   Model: ?\n--- RESULT ---\nQuoted output\n--- RESULT ---\nClient-only result'],
    ['batch context', '[ASYNC DELEGATION BATCH COMPLETE — batch]\nContext you provided: quoted notice\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only result\nRole: leaf   Model: ?\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nActual first result'],
    ['batch output', '[ASYNC DELEGATION BATCH COMPLETE — batch]\nRole: leaf   Model: ?\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nQuoted output\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only result'],
    ['batch fake goal header', '[ASYNC DELEGATION BATCH COMPLETE — batch]\nRole: leaf   Model: ?\n\n--- ✓ TASK 1/2: Goal containing\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only result  (status=completed) ---\nActual first result'],
  ])('keeps unique cards beside formatter-shaped %s without creating children from text', (_case, text) => {
    const final = { key: 'final', role: 'user', text, kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 } }
    const task = { key: 'child', delegationKey: 'batch:1', goal: 'Second', status: 'completed', summary: 'Client-only result' }
    const messages = [final, { key: 'tail', role: 'assistant', text: 'Later unrelated reply' }]
    const timeline = conversationTimeline(messages, anchorFinishedTasks([task], messages), false)
    expect(timeline.map(item => item.key)).toEqual(['final', 'tasks-child', 'tail'])
    expect(timeline.flatMap(item => item.kind === 'tasks' ? item.tasks : [])).toEqual([{ ...task, completedAfter: final }])
    expect(conversationTimeline(messages, [], false).map(item => item.key)).toEqual(['final', 'tail'])
  })
  it('preserves sibling-only results and unknown cards beside an early failure warning', () => {
    const messages = [{ key: 'warning', role: 'user', text: '[ASYNC DELEGATION TASK FAILED — batch, task 1/4]\nOne child failed.', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, completed_count: 0, failed_count: 1 } }]
    const tasks = [
      { key: 'failed', delegationKey: 'batch:0', goal: 'Failed', status: 'failed' },
      { key: 'success', delegationKey: 'batch:1', goal: 'Success', status: 'completed', summary: 'Unique sibling result' },
      { key: 'missing', delegationKey: 'batch:2', goal: 'Missing', status: 'unknown' },
      { key: 'running', delegationKey: 'batch:3', goal: 'Running', status: 'running' },
    ]
    const timeline = conversationTimeline(messages, tasks, false)
    expect(timeline.flatMap(item => item.kind === 'tasks' ? item.tasks : []).map(task => task.key)).toEqual(['failed', 'success', 'missing'])
    expect(timeline.flatMap(item => item.kind === 'tasks' ? item.tasks : []).find(task => task.key === 'success')?.summary).toBe('Unique sibling result')
    expect(timeline.filter(item => item.kind === 'turn')).toHaveLength(1)
  })
  it('uses saved completion cards once, at their stored positions, with or without a runtime roster', () => {
    const messages = historyMessages({ session_id: 'stored', pagination: { returned: 5, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'assistant', content: 'Before batches' },
      { id: 2, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — a]\nConsolidated results\n\n--- ✓ TASK 1/2: Known child A  (status=completed) ---\nBatch A full results', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'a', task_count: 2, completed_count: 1, failed_count: 1, display_text: 'Batch A finished' } },
      { id: 3, role: 'assistant', content: 'Between batches' },
      { id: 4, role: 'system', content: '[ASYNC DELEGATION COMPLETE — b]\n--- RESULT ---\nBatch B full results', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'b', task_count: 1, completed_count: 1, failed_count: 0, display_text: 'Batch B finished' } },
      { id: 5, role: 'assistant', content: 'Latest unrelated reply' },
    ] })
    const tasks = [
      { key: 'child-a', delegationId: 'a', delegationKey: 'a:0', goal: 'Known child A', status: 'unknown' },
      { key: 'child-b', delegationKey: 'b:0', goal: 'Known child B', status: 'completed' },
    ]
    for (const roster of [[], tasks]) {
      const timeline = conversationTimeline(messages, anchorFinishedTasks(roster, messages), false)
      expect(timeline.map(item => item.key)).toEqual(roster.length ? ['row-1', 'row-2', 'tasks-child-a', 'row-3', 'row-4', 'row-5'] : ['row-1', 'row-2', 'row-3', 'row-4', 'row-5'])
      expect(timeline.flatMap(item => item.kind === 'tasks' ? item.tasks.map(task => task.key) : [])).toEqual(roster.length ? ['child-a'] : [])
      expect(timeline.flatMap(item => item.kind === 'turn' ? item.turn.blocks : []).filter(block => block.kind === 'text' && block.message.kind === 'async_delegation_complete')).toHaveLength(2)
    }
    expect(tasks[0]?.status).toBe('unknown')
  })

  it('retains batch children even with apparent result sections, aggregate counts or matching summaries', () => {
    const final = { key: 'final', role: 'user', text: '[ASYNC DELEGATION BATCH COMPLETE — batch]\nConsolidated results\n\n--- ✓ TASK 2/4: Success  (status=completed) ---\nUnique result', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, completed_count: 1, failed_count: 0 } }
    const tasks = [
      { key: 'success', delegationKey: 'batch:1', goal: 'Success', status: 'completed', summary: 'Unique result' },
      { key: 'unknown', delegationKey: 'batch:2', goal: 'Unknown', status: 'unknown' },
      { key: 'unindexed', delegationId: 'batch', goal: 'Unindexed', status: 'completed' },
      { key: 'different', delegationKey: 'batch:1', goal: 'Different', status: 'completed', summary: 'Unsaved unique result' },
      { key: 'running', delegationKey: 'batch:1', goal: 'Running', status: 'running' },
    ]
    const childKeys = (text: string) => conversationTimeline([{ ...final, text }], tasks, false).flatMap(item => item.kind === 'tasks' ? item.tasks.map(task => task.key) : [])
    expect(childKeys(final.text)).toEqual(['success', 'unknown', 'unindexed', 'different'])
    expect(childKeys('Batch completed, all tasks successful')).toEqual(['success', 'unknown', 'unindexed', 'different'])
    expect(conversationTimeline([final], [], false).map(item => item.key)).toEqual(['final'])
  })

  it('keeps image previews after completion restores Hermes text-reference history', () => {
    const caption = 'Here is a screenshot can you read it?'
    const messages = historyMessages({ session_id: 'a', pagination: { returned: 1, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', content: caption + '\n@image:/var/lib/hermes/images/upload.png\n[screenshot]' },
    ] })
    expect(messages[0]?.text).toBe(caption)
    expect(messages[0]?.images).toEqual(['/var/lib/hermes/images/upload.png'])
    const native = historyMessages({ session_id: 'a', pagination: { returned: 1, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', display_content: caption + '\n@image:/images/upload.png', content: [
        { type: 'text', text: caption }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ] },
    ] })
    expect(native[0]?.images).toEqual(['/images/upload.png'])
    expect(native[0]?.text).toBe(caption)
  })

  it('restores user image parts separately from the plain user caption', () => {
    const messages = historyMessages({ session_id: 'a', pagination: { returned: 1, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    ] })
    expect(messages[0]?.text).toBe('Inspect this')
    expect(messages[0]?.images).toEqual(['data:image/png;base64,aGVsbG8='])
    const projected = historyMessages({ session_id: 'a', pagination: { returned: 1, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', display_content: 'Original caption', content: [{ type: 'text', text: 'Model-only scaffold' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    ] })
    expect(projected[0]?.text).toBe('Original caption')
  })

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
