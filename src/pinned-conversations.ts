import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { HermesApi, HttpError } from './hermes/api'
import type { SessionRow } from './hermes/types'

export interface ConversationPin { id: string; profile: string }
const storageKey = 'agora.pinned-conversations'
export const conversationKey = (session: Pick<SessionRow, 'id' | 'profile'>) => JSON.stringify([session.profile || 'default', session.id])
export const pinScope = (endpoint: string) => endpoint.replace(/\/+$/, '')

export function readPins(storage: Pick<Storage, 'getItem'>, endpoint: string): ConversationPin[] {
  try {
    const saved = JSON.parse(storage.getItem(storageKey) || '{}')
    const pins = saved[pinScope(endpoint)]
    if (!Array.isArray(pins)) return []
    const seen = new Set<string>()
    return pins.filter((pin): pin is ConversationPin => {
      if (!pin || typeof pin.id !== 'string' || !pin.id || typeof pin.profile !== 'string' || !pin.profile) return false
      const key = conversationKey(pin)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(({ id, profile }) => ({ id, profile }))
  } catch { return [] }
}

export function writePins(storage: Pick<Storage, 'getItem' | 'setItem'>, endpoint: string, pins: ConversationPin[]) {
  let saved: Record<string, unknown> = {}
  try {
    const value = JSON.parse(storage.getItem(storageKey) || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value
  } catch { /* Replace invalid pin preferences when the user saves a new pin. */ }
  saved[pinScope(endpoint)] = pins.map(({ id, profile }) => ({ id, profile }))
  storage.setItem(storageKey, JSON.stringify(saved))
}

export function usePinnedConversations(endpoint: Ref<string>, connected: Ref<boolean>, sessions: Ref<SessionRow[]>, api = new HermesApi()) {
  const pins = ref<ConversationPin[]>([])
  const details = ref<Record<string, SessionRow>>({})
  const error = ref('')
  const pending = new Set<string>()
  let generation = 0
  let disposed = false
  const pinnedKeys = computed(() => new Set(pins.value.map(conversationKey)))
  const isPinned = (session: Pick<SessionRow, 'id' | 'profile'>) => pinnedKeys.value.has(conversationKey(session))

  function save(next: ConversationPin[]) {
    try {
      writePins(window.localStorage, endpoint.value, next)
      pins.value = next
      error.value = ''
    } catch { error.value = 'Could not save pins in this browser. Check browser storage permissions.' }
  }
  function toggle(session: Pick<SessionRow, 'id' | 'profile'>) {
    const pin = { id: session.id, profile: session.profile || 'default' }
    if (!pin.id || !connected.value) return
    save(isPinned(pin) ? pins.value.filter(value => conversationKey(value) !== conversationKey(pin)) : [...pins.value, pin])
  }
  function remove(session: Pick<SessionRow, 'id' | 'profile'>) {
    if (isPinned(session)) save(pins.value.filter(value => conversationKey(value) !== conversationKey(session)))
  }
  function reload() {
    generation++
    pending.clear()
    details.value = {}
    error.value = ''
    try { pins.value = readPins(window.localStorage, endpoint.value) }
    catch { pins.value = [] }
  }
  watch(endpoint, reload, { immediate: true })
  watch(connected, value => {
    if (!value) { generation++; pending.clear() }
  })
  watch([pins, sessions, connected], () => {
    if (!connected.value) return
    const scope = generation
    const loaded = new Set(sessions.value.map(conversationKey))
    for (const pin of pins.value) {
      const key = conversationKey(pin)
      if (loaded.has(key) || details.value[key] || pending.has(key)) continue
      pending.add(key)
      void api.session(pin.id, pin.profile).then(session => {
        if (!disposed && scope === generation && isPinned(pin)) details.value[key] = { ...session, id: pin.id, profile: pin.profile }
      }).catch(value => {
        if (!disposed && scope === generation && value instanceof HttpError && value.status === 404) remove(pin)
      }).finally(() => { if (scope === generation) pending.delete(key) })
    }
  }, { immediate: true })
  function storageChanged(event: StorageEvent) { if (event.key === storageKey || event.key === null) reload() }
  window.addEventListener('storage', storageChanged)
  onBeforeUnmount(() => { disposed = true; generation++; window.removeEventListener('storage', storageChanged) })

  function ordered(visible: SessionRow[], query: string): SessionRow[] {
    const rows = new Map(visible.map(session => [conversationKey(session), session]))
    const loaded = new Map(sessions.value.map(session => [conversationKey(session), session]))
    const matching = query.trim().toLocaleLowerCase()
    const pinned: SessionRow[] = []
    for (const pin of pins.value) {
      const key = conversationKey(pin)
      const session = rows.get(key) || loaded.get(key) || details.value[key] || { ...pin, title: 'Pinned conversation' }
      if (matching && !rows.has(key) && !(session.title || '').toLocaleLowerCase().includes(matching) && !session.id.toLocaleLowerCase().includes(matching)) continue
      pinned.push(session)
      rows.delete(key)
    }
    return [...pinned, ...rows.values()]
  }
  return { pins, error, isPinned, toggle, remove, ordered }
}
