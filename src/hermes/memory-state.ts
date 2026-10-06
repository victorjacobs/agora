import type { HermesApi } from './api'
import type { Gateway } from './gateway'

export const memorySections = [
  { id: 'pending', title: 'Pending updates' },
  { id: 'memory', title: 'Saved memory' },
  { id: 'profile', title: 'User profile' },
  { id: 'soul', title: 'Soul & instructions' },
  { id: 'providers', title: 'Memory providers' },
] as const
export type MemorySection = typeof memorySections[number]['id']
export type MemoryInspectionSection = Exclude<MemorySection, 'pending'>
export interface SavedMemoryEntry { id: string; title: string; preview: string }
export interface MemoryProviderState { name: string; description: string; status: string; available: boolean; configured: boolean }
export interface MemoryInspection {
  profile: string
  entries?: SavedMemoryEntry[]
  soul?: string
  description?: string
  personality?: string
  prompt?: string
  errors?: string[]
  provider?: string
  providers?: MemoryProviderState[]
  memoryBytes?: number
  userBytes?: number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hermes returned unsupported memory data.')
  return value as Record<string, unknown>
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Unavailable from Hermes.'

async function resolveProfile(api: HermesApi, profile?: string) {
  if (profile) return profile
  const result = await api.request<{ current?: string }>('/api/profiles/active')
  if (!result.current || result.current === 'custom') throw new Error('Hermes cannot identify its current profile. Open a conversation with a named profile first.')
  return result.current
}

export async function inspectMemory(api: HermesApi, gateway: Gateway, section: MemoryInspectionSection, profile?: string, runtime?: string): Promise<MemoryInspection> {
  const name = await resolveProfile(api, profile)
  const query = api.query({ profile: name })
  if (section === 'memory' || section === 'profile') {
    const graph = record(await api.request(`/api/learning/graph?${query}`))
    if (!Array.isArray(graph.nodes)) throw new Error('Saved memory is unavailable from this Hermes server.')
    const cards = Array.isArray(graph.memory) ? graph.memory : []
    const entries = graph.nodes.flatMap(value => {
      const node = record(value)
      if (node.kind !== 'memory' || node.memorySource !== section || typeof node.id !== 'string' || typeof node.label !== 'string') return []
      const id = node.id
      const card = cards.find(value => value && typeof value === 'object' && value.source === section && typeof value.fingerprint === 'string' && id.endsWith(`:${value.fingerprint}`))
      return [{ id: node.id, title: node.label, preview: typeof card?.body === 'string' ? card.body : '' }]
    })
    return { profile: name, entries }
  }
  if (section === 'soul') {
    const results = await Promise.allSettled([
      gateway.request('profiles.describe', { name }),
      gateway.request('config.get', { key: 'personality', session_id: runtime || undefined, profile: name }),
      gateway.request('config.get', { key: 'prompt', session_id: runtime || undefined, profile: name }),
    ])
    const state: MemoryInspection = { profile: name, errors: [] }
    for (const [index, result] of results.entries()) {
      const label = ['Soul', 'Personality', 'Custom instructions'][index]
      if (result.status === 'rejected') { state.errors!.push(`${label}: ${message(result.reason)}`); continue }
      try {
        const value = record(result.value)
        if (index === 0) {
          if (value.name !== name || typeof value.soul !== 'string') throw new Error('No supported soul snapshot was returned.')
          state.soul = value.soul
          state.description = typeof value.description === 'string' ? value.description : ''
        } else if (index === 1 && typeof value.value === 'string') state.personality = value.value
        else if (index === 2 && typeof value.prompt === 'string') state.prompt = value.prompt
        else throw new Error('No supported setting was returned.')
      } catch (error) { state.errors!.push(`${label}: ${message(error)}`) }
    }
    return state
  }
  const status = record(await api.request(`/api/memory?${query}`))
  if (typeof status.active !== 'string' || !Array.isArray(status.providers)) throw new Error('Memory provider status is unavailable from this Hermes server.')
  const files = record(status.builtin_files)
  const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return { profile: name, provider: status.active || 'builtin', memoryBytes: bytes(files.memory), userBytes: bytes(files.user),
    providers: status.providers.map(value => {
      const provider = record(value)
      if (typeof provider.name !== 'string') throw new Error('Hermes returned an unsupported memory provider.')
      return { name: provider.name, description: typeof provider.description === 'string' ? provider.description : '',
        status: typeof provider.status === 'string' ? provider.status : 'unknown', available: provider.available === true, configured: provider.configured === true }
    }) }
}

export async function readMemoryEntry(api: HermesApi, id: string, profile: string): Promise<string> {
  if (!/^memory:(memory|profile):\d+(?::[a-f\d]+)?$/.test(id) || !profile) throw new Error('Choose a saved memory entry first.')
  const result = record(await api.request(`/api/learning/node?${api.query({ id, profile })}`))
  if (result.ok !== true || result.kind !== 'memory' || result.id !== id || typeof result.content !== 'string') throw new Error('Hermes could not read this entry. Refresh the list and try again.')
  return result.content
}

export async function mutateMemoryEntry(api: HermesApi, id: string, profile: string, content?: string): Promise<void> {
  // Legacy positional IDs cannot safely identify an entry after the list changes.
  if (!/^memory:(memory|profile):\d+:[a-f\d]+$/.test(id) || !profile) throw new Error('Refresh the list to select an entry with a stable ID.')
  if (content !== undefined && !content.trim()) throw new Error('Memory cannot be empty. Use Delete to remove it.')
  const result = record(await api.request('/api/learning/node', {
    method: content === undefined ? 'DELETE' : 'PUT',
    body: JSON.stringify({ id, profile, ...(content === undefined ? {} : { content }) }),
  }))
  if (result.ok !== true) throw new Error(typeof result.message === 'string' ? result.message : 'Hermes did not confirm the change. Refresh the list before trying again.')
}
