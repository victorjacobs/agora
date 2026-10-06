import { describe, expect, it, vi } from 'vitest'
import { Gateway } from '../src/hermes/gateway'
import { isMemoryApproval, memoryApprovals, parseMemoryPending, pendingMemory } from '../src/hermes/memory'

describe('memory review protocol', () => {
  it('recognizes memory approvals and deduplicates the two approval transports', () => {
    const approval = { request_id: 'one', description: 'Save to memory: add to user profile', command: 'A complete preference' }
    const request = { id: 'request-one', method: 'approval', params: approval }
    expect(memoryApprovals([approval, { request_id: 'two', command: 'rm -rf', description: 'Run command' }], [request])).toEqual([{ ...approval, key: 'request-one', request }])
    expect(isMemoryApproval({ description: 'Run command' })).toBe(false)
    expect(isMemoryApproval({ tool_name: 'memory' })).toBe(true)
  })

  it('keeps staged previews and pinned target details without claiming to have the full proposal', () => {
    const pending = parseMemoryPending('Pending memory writes (2):\n  abcdef01 [auto]  replace in memory: entry matching: old\nwhole entry becomes: new preview\n      replaces entry: Full old entry\nwith another line\n  12345678  add to memory: Another preview\n\nApply: /memory approve <id>   Reject: /memory reject <id>')
    expect(pending.previews).toEqual([
      { id: 'abcdef01', background: true, summary: 'replace in memory: entry matching: old\nwhole entry becomes: new preview', targetDetails: 'replaces entry: Full old entry\nwith another line' },
      { id: '12345678', background: false, summary: 'add to memory: Another preview', targetDetails: '' },
    ])
    expect(parseMemoryPending('No pending memory writes.').previews).toEqual([])
    expect(() => parseMemoryPending('Pending memory writes (1):\nunsupported')).toThrow('incomplete')
    expect(() => parseMemoryPending('Memory command unavailable')).toThrow('supported format')
  })

  it('reads pending writes from the current runtime without submitting a chat prompt or approving anything', async () => {
    const gateway = new Gateway()
    const request = vi.spyOn(gateway, 'request').mockResolvedValue({ type: 'exec', output: 'No pending memory writes.' })
    expect(await pendingMemory(gateway, 'runtime-a', 'work')).toEqual({ previews: [] })
    expect(request).toHaveBeenCalledExactlyOnceWith('command.dispatch', { name: 'memory', arg: 'pending', session_id: 'runtime-a', profile: 'work' })
    request.mockResolvedValue({ type: 'send', message: 'Run a prompt' })
    await expect(pendingMemory(gateway, 'runtime-a', 'work')).rejects.toThrow('unavailable')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
