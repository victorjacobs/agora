import { describe, expect, it } from 'vitest'
import { resultStatus, resultOutput, groupResultDays, resultTime } from '../src/hermes/results'
import type { HistoryPage } from '../src/hermes/types'

const page = (messages: HistoryPage['messages']): HistoryPage => ({ session_id: 'run', messages, pagination: { offset: 0, returned: messages.length, limit: 50 } })
describe('result evidence', () => {
  it('groups runs by individual local calendar days with readable headings', () => {
    const epoch = (year: number, month: number, day: number, hour = 12) => new Date(year, month, day, hour).getTime() / 1000
    const rows = [
      { run: { id: 'today', started_at: epoch(2026, 9, 7) } },
      { run: { id: 'midnight', started_at: epoch(2026, 9, 7, 0) } },
      { run: { id: 'yesterday', started_at: epoch(2026, 9, 6, 23) } },
      { run: { id: 'older', started_at: epoch(2026, 9, 5) } },
      { run: { id: 'prior-year', started_at: epoch(2025, 9, 7) } },
      { run: { id: 'missing' } },
      { run: { id: 'invalid', started_at: NaN } },
    ]
    const groups = groupResultDays(rows, new Date(2026, 9, 7, 15))
    expect(groups.map(group => [group.label, group.results.map(row => row.run.id)])).toEqual([
      ['Today, 7 October', ['today', 'midnight']],
      ['Yesterday, 6 October', ['yesterday']],
      ['5 October', ['older']], ['7 October 2025', ['prior-year']],
      ['Date unavailable', ['missing', 'invalid']],
    ])
    expect(groupResultDays([], new Date(2026, 9, 7))).toEqual([])
    expect(groupResultDays(rows.slice(0, 1), new Date(2026, 9, 8))[0]?.label).toBe('Yesterday, 7 October')
  })
  it('formats local run times and handles invalid or missing timestamps', () => {
    const now = new Date(2026, 9, 7, 15)
    expect(resultTime(new Date(2026, 9, 7, 8, 5).getTime() / 1000, now)).toBe('Today at 08:05')
    expect(resultTime(new Date(2026, 9, 6, 23, 50).getTime() / 1000, now)).toBe('Yesterday at 23:50')
    expect(resultTime(new Date(2025, 9, 7, 8, 5).getTime() / 1000, now)).toBe('7 October 2025 at 08:05')
    expect(resultTime(undefined, now)).toBe('Date unavailable')
    expect(resultTime(Infinity, now)).toBe('Date unavailable')
  })
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
