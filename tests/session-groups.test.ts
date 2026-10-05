import { describe, expect, it } from 'vitest'
import { groupSessions } from '../src/session-groups'

describe('sidebar date groups', () => {
  it('uses local calendar days and preserves conversation order', () => {
    const epoch = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime() / 1000
    const sessions = [
      { id: 'today', last_active: epoch(5) },
      { id: 'midnight', last_active: epoch(5, 0) },
      { id: 'yesterday', last_active: epoch(4, 23) },
      { id: 'week', last_active: new Date(2026, 8, 28).getTime() / 1000 },
      { id: 'month', last_active: new Date(2026, 8, 5).getTime() / 1000 },
      { id: 'older', last_active: new Date(2026, 8, 4, 23).getTime() / 1000 },
      { id: 'missing' },
    ]
    const groups = groupSessions(sessions, new Date(2026, 9, 5, 15))
    expect(groups.map(group => [group.label, group.sessions.map(session => session.id)])).toEqual([
      ['Today', ['today', 'midnight']], ['Yesterday', ['yesterday']], ['Previous 7 days', ['week']],
      ['Previous 30 days', ['month']], ['Older', ['older']], ['Undated', ['missing']],
    ])
    expect(sessions).toHaveLength(7)
  })

  it('omits empty groups and updates the groups when the day changes', () => {
    const sessions = [{ id: 'chat', last_active: new Date(2026, 9, 5, 23).getTime() / 1000 }]
    expect(groupSessions(sessions, new Date(2026, 9, 5, 23))[0]?.label).toBe('Today')
    expect(groupSessions(sessions, new Date(2026, 9, 6, 0))[0]?.label).toBe('Yesterday')
    expect(groupSessions([], new Date())).toEqual([])
  })
})
