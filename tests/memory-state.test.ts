import { describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'
import { Gateway, RpcError } from '../src/hermes/gateway'
import { inspectMemory, readMemoryEntry, mutateMemoryEntry } from '../src/hermes/memory-state'

function setup() {
  const api = new HermesApi()
  const gateway = new Gateway()
  return { api, gateway, http: vi.spyOn(api, 'request'), rpc: vi.spyOn(gateway, 'request') }
}

describe('read-only memory inspection', () => {
  it('separates built-in memory and user entries and reads full text through the node API', async () => {
    const { api, gateway, http, rpc } = setup()
    const graph = { nodes: [
      { kind: 'skill', id: 'skill', label: 'Skill' },
      { kind: 'memory', memorySource: 'memory', id: 'memory:memory:0:abcdef', label: 'A memory' },
      { kind: 'memory', memorySource: 'profile', id: 'memory:profile:1:123abc', label: 'A preference' },
    ], memory: [{ source: 'memory', fingerprint: 'abcdef', body: 'Preview…' }, { source: 'profile', fingerprint: '123abc', body: 'Preference preview' }] }
    http.mockResolvedValue(graph)
    expect(await inspectMemory(api, gateway, 'memory', 'work')).toEqual({ profile: 'work', entries: [{ id: 'memory:memory:0:abcdef', title: 'A memory', preview: 'Preview…' }] })
    expect(http).toHaveBeenCalledExactlyOnceWith('/api/learning/graph?profile=work')
    expect(rpc).not.toHaveBeenCalled()
    expect((await inspectMemory(api, gateway, 'profile', 'work')).entries?.[0]?.title).toBe('A preference')
    http.mockResolvedValue({ ok: true, kind: 'memory', id: 'memory:memory:0:abcdef', content: 'Full entry beyond the preview' })
    expect(await readMemoryEntry(api, 'memory:memory:0:abcdef', 'work')).toBe('Full entry beyond the preview')
    expect(http).toHaveBeenLastCalledWith('/api/learning/node?id=memory%3Amemory%3A0%3Aabcdef&profile=work')
    http.mockResolvedValue({ ok: true, kind: 'memory', id: 'memory:memory:1:abcdef', content: 'Another entry' })
    await expect(readMemoryEntry(api, 'memory:memory:0:abcdef', 'work')).rejects.toThrow('Refresh')
    http.mockClear()
    await expect(readMemoryEntry(api, '/memories/MEMORY.md', 'work')).rejects.toThrow('Choose')
    expect(http).not.toHaveBeenCalled()
  })

  it('resolves the dashboard current profile rather than the sticky active profile', async () => {
    const { api, gateway, http } = setup()
    http.mockResolvedValueOnce({ active: 'other', current: 'work' }).mockResolvedValueOnce({ nodes: [], memory: [] })
    expect(await inspectMemory(api, gateway, 'memory')).toEqual({ profile: 'work', entries: [] })
    expect(http).toHaveBeenNthCalledWith(2, '/api/learning/graph?profile=work')
    http.mockResolvedValue({ active: 'other', current: 'custom' })
    await expect(inspectMemory(api, gateway, 'memory')).rejects.toThrow('cannot identify')
  })

  it('loads soul, personality, and instructions independently and never requests secrets or mutations', async () => {
    const { api, gateway, http, rpc } = setup()
    rpc.mockImplementation(async (method, params) => {
      if (method === 'profiles.describe') return { name: 'work', soul: 'Be direct. <script>unsafe</script>', description: 'Work profile' }
      if (params?.key === 'personality') throw new RpcError(-32601, 'Unsupported method')
      if (params?.key === 'prompt') return { prompt: 'Keep changes small.' }
      throw new Error('Unexpected RPC')
    })
    expect(await inspectMemory(api, gateway, 'soul', 'work', 'runtime')).toEqual({ profile: 'work', soul: 'Be direct. <script>unsafe</script>', description: 'Work profile', prompt: 'Keep changes small.', errors: ['Personality: Unsupported method'] })
    expect(rpc.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['profiles.describe', { name: 'work' }],
      ['config.get', { key: 'personality', session_id: 'runtime', profile: 'work' }],
      ['config.get', { key: 'prompt', session_id: 'runtime', profile: 'work' }],
    ])
    expect(http).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ name: 'other', soul: 'Wrong profile' })
    const result = await inspectMemory(api, gateway, 'soul', 'work')
    expect(result.soul).toBeUndefined()
    expect(result.errors?.[0]).toContain('No supported soul snapshot')
  })

  it('exposes provider status and file sizes without provider configuration or credentials', async () => {
    const { api, gateway, http } = setup()
    http.mockResolvedValue({ active: '', builtin_files: { memory: 250, user: 125 }, providers: [{ name: 'external', description: 'External memory', status: 'ready', available: true, configured: true, setup: { credential: 'must not project' } }] })
    expect(await inspectMemory(api, gateway, 'providers', 'work')).toEqual({ profile: 'work', provider: 'builtin', memoryBytes: 250, userBytes: 125, providers: [{ name: 'external', description: 'External memory', status: 'ready', available: true, configured: true }] })
    expect(http).toHaveBeenCalledExactlyOnceWith('/api/memory?profile=work')
    http.mockResolvedValue({})
    await expect(inspectMemory(api, gateway, 'memory', 'work')).rejects.toThrow('unavailable')
  })
})

describe('memory mutations', () => {
  it('uses the exact profile-scoped HTTP contract for edits and deletes', async () => {
    const { api, http } = setup()
    http.mockResolvedValue({ ok: true })
    await mutateMemoryEntry(api, 'memory:memory:0:abcdef', 'work', 'New text')
    expect(http).toHaveBeenLastCalledWith('/api/learning/node', { method: 'PUT', body: JSON.stringify({ id: 'memory:memory:0:abcdef', profile: 'work', content: 'New text' }) })
    await mutateMemoryEntry(api, 'memory:profile:1:abcdef', 'personal')
    expect(http).toHaveBeenLastCalledWith('/api/learning/node', { method: 'DELETE', body: JSON.stringify({ id: 'memory:profile:1:abcdef', profile: 'personal' }) })
  })

  it('refuses positional IDs, skills, empty content, and missing profiles before sending', async () => {
    const { api, http } = setup()
    for (const id of ['memory:memory:0', 'my-skill', '../MEMORY.md']) await expect(mutateMemoryEntry(api, id, 'work')).rejects.toThrow('stable ID')
    await expect(mutateMemoryEntry(api, 'memory:memory:0:abcdef', '')).rejects.toThrow('stable ID')
    await expect(mutateMemoryEntry(api, 'memory:memory:0:abcdef', 'work', '  ')).rejects.toThrow('Use Delete')
    expect(http).not.toHaveBeenCalled()
  })

  it('surfaces stale and unsupported failures without retrying', async () => {
    const { api, http } = setup()
    http.mockResolvedValue({ ok: false, message: 'memory node id is stale — refresh the graph' })
    await expect(mutateMemoryEntry(api, 'memory:memory:0:abcdef', 'work')).rejects.toThrow('stale')
    expect(http).toHaveBeenCalledTimes(1)
    http.mockResolvedValue({})
    await expect(mutateMemoryEntry(api, 'memory:memory:0:abcdef', 'work', 'Update')).rejects.toThrow('did not confirm')
    http.mockRejectedValue(new Error('Network lost'))
    await expect(mutateMemoryEntry(api, 'memory:memory:0:abcdef', 'work')).rejects.toThrow('Network lost')
    expect(http).toHaveBeenCalledTimes(3)
  })
})
