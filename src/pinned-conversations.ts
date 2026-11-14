import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { HermesApi, HttpError } from './hermes/api'
import type { SessionRow } from './hermes/types'

export interface ConversationPin { id: string; profile: string }
const storageKey = 'agora.pinned-conversations'
export const conversationKey = (session: Pick<SessionRow, 'id' | 'profile'>) => JSON.stringify([session.profile || 'default', session.id])
export const pinScope = (endpoint: string) => endpoint.replace(/\/+$/, '')

function savedPins(storage: Pick<Storage, 'getItem'>): Record<string, unknown> {
  const saved = JSON.parse(storage.getItem(storageKey) || '{}')
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid pin backup')
  return saved
}
function references(value: unknown): ConversationPin[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((pin): pin is ConversationPin => {
    if (!pin || typeof pin.id !== 'string' || !pin.id || typeof pin.profile !== 'string' || !pin.profile) return false
    const key = conversationKey(pin)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(({ id, profile }) => ({ id, profile }))
}
export function readPins(storage: Pick<Storage, 'getItem'>, endpoint: string): ConversationPin[] {
  try { return references(savedPins(storage)[pinScope(endpoint)]) } catch { return [] }
}
export function writePins(storage: Pick<Storage, 'getItem' | 'setItem'>, endpoint: string, pins: ConversationPin[]) {
  const saved = savedPins(storage)
  saved[pinScope(endpoint)] = pins.map(({ id, profile }) => ({ id, profile }))
  storage.setItem(storageKey, JSON.stringify(saved))
}
const nativePinned = (row: Pick<SessionRow, 'pinned'>) => row.pinned === true || row.pinned === 1
const hasFlag = (row: SessionRow) => [true, false, 0, 1].includes(row.pinned as boolean)
const storageError = 'Could not update the old pin backup. Allow browser storage, then Retry pins before unpinning migrated chats.'

export function usePinnedConversations(endpoint: Ref<string>, connected: Ref<boolean>, sessions: Ref<SessionRow[]>, api = new HermesApi(), profile: Ref<string | undefined> = ref(undefined), selected: Ref<Pick<SessionRow, 'id' | 'profile'>> = ref({ id: '' })) {
  const legacy = ref<ConversationPin[]>([])
  const details = ref<Record<string, SessionRow>>({})
  const error = ref('')
  const busy = ref(new Set<string>())
  const uncertain = ref(new Set<string>())
  const resolvedProfile = ref('')
  // A failed acknowledgement must retry storage, never replay an already-confirmed import.
  const confirmed = new Set<string>()
  let generation = 0, revision = 0, refreshSequence = 0
  let disposed = false, migrationRequested = false, reimportRequested = false
  const operationKey = (pin: Pick<SessionRow, 'id' | 'profile'>) => JSON.stringify([pinScope(endpoint.value), pin.profile || resolvedProfile.value, pin.id])
  const valid = (scope: number) => !disposed && connected.value && Boolean(endpoint.value) && scope === generation
  const rowFor = (pin: Pick<SessionRow, 'id' | 'profile'>) => Object.values(details.value).find(row => row.profile === (pin.profile || resolvedProfile.value) && row._lineage_ids?.includes(pin.id)) || details.value[conversationKey({ ...pin, profile: pin.profile || resolvedProfile.value })]
  const legacyFor = (pin: Pick<SessionRow, 'id' | 'profile'>) => legacy.value.filter(value => conversationKey(rowFor(value) || value) === conversationKey(rowFor(pin) || { ...pin, profile: pin.profile || resolvedProfile.value }))
  const pins = computed<ConversationPin[]>(() => {
    const result = new Map<string, ConversationPin>()
    for (const row of Object.values(details.value)) if (nativePinned(row)) result.set(conversationKey(row), { id: row.id, profile: row.profile! })
    for (const pin of legacy.value) {
      const row = rowFor(pin)
      const canonical = row || pin
      result.set(conversationKey(canonical), { id: canonical.id, profile: canonical.profile! })
    }
    return [...result.values()]
  })
  const isPinned = (pin: Pick<SessionRow, 'id' | 'profile'>) => Boolean(legacyFor(pin).length) || nativePinned(rowFor(pin) || {})
  const isBusy = (pin: Pick<SessionRow, 'id' | 'profile'>) => [pin.id, ...(rowFor(pin)?._lineage_ids || [])].some(id => busy.value.has(operationKey({ id, profile: pin.profile || resolvedProfile.value })))
  const pendingCount = computed(() => legacy.value.length)
  const uncertainCount = computed(() => legacy.value.filter(pin => uncertain.value.has(operationKey(pin))).length)

  function loadLegacy() {
    if (!endpoint.value || !resolvedProfile.value) return
    try { legacy.value = references(savedPins(window.localStorage)[pinScope(endpoint.value)]).filter(pin => pin.profile === resolvedProfile.value) }
    catch { error.value = storageError }
  }
  function attempted(pin: ConversationPin) {
    const saved = savedPins(window.localStorage)[pinScope(endpoint.value)]
    return Array.isArray(saved) && saved.some(value => value?.id === pin.id && value.profile === pin.profile && value.migrationAttempted === true)
  }
  function recordAttempt(pin: ConversationPin) {
    const storage = window.localStorage, saved = savedPins(storage), scope = pinScope(endpoint.value)
    if (!Array.isArray(saved[scope])) throw new Error('Pin backup is unavailable')
    saved[scope] = saved[scope].map(value => value?.id === pin.id && value.profile === pin.profile ? { ...value, migrationAttempted: true } : value)
    const serialized = JSON.stringify(saved)
    storage.setItem(storageKey, serialized)
    if (storage.getItem(storageKey) !== serialized) throw new Error('Pin backup was not saved')
  }
  function acknowledge(pin: ConversationPin) {
    const storage = window.localStorage
    const saved = savedPins(storage)
    const scope = pinScope(endpoint.value)
    const previous = saved[scope]
    // Preserve unrelated/unknown references verbatim, not a stale browser snapshot.
    if (Array.isArray(previous)) saved[scope] = previous.filter(value => !value || value.id !== pin.id || value.profile !== pin.profile)
    const serialized = JSON.stringify(saved)
    storage.setItem(storageKey, serialized)
    if (storage.getItem(storageKey) !== serialized) throw new Error('Pin backup was not saved')
    legacy.value = legacy.value.filter(value => conversationKey(value) !== conversationKey(pin))
    confirmed.delete(operationKey(pin))
    uncertain.value.delete(operationKey(pin))
  }
  function store(row: SessionRow, pin: ConversationPin) {
    if (typeof row.id !== 'string' || !row.id || row.profile !== pin.profile || !hasFlag(row)) throw new Error('Hermes did not return pin metadata')
    const canonical = rowFor(row)
    if (canonical && canonical.id !== row.id && canonical._lineage_ids?.includes(row.id)) {
      canonical.pinned = row.pinned
      delete details.value[conversationKey(row)]
      return canonical
    }
    details.value[conversationKey(row)] = { ...row }
    return row
  }
  async function importPin(pin: ConversationPin, scope: number, allowReimport: boolean) {
    const key = operationKey(pin)
    if (!valid(scope) || isBusy(pin) || !legacy.value.some(value => conversationKey(value) === conversationKey(pin))) return
    busy.value.add(key); revision++
    try {
      if (!confirmed.has(key)) {
        const before = await api.session(pin.id, pin.profile)
        if (!valid(scope)) return
        store(before, pin)
        try {
          if (!nativePinned(before) && attempted(pin) && !allowReimport) {
            uncertain.value.add(key)
            error.value = 'Some old pins may have been unpinned elsewhere. Import old pins to pin them again, or unpin them here to accept the server state.'
            return
          }
          recordAttempt(pin)
        } catch { error.value = storageError; return }
        if (!nativePinned(before)) {
          await api.setPinned(pin.id, true, pin.profile)
          if (!valid(scope)) return
        }
        const after = await api.session(pin.id, pin.profile)
        if (!valid(scope)) return
        if (!nativePinned(store(after, pin))) throw new Error('Pin was not confirmed')
        confirmed.add(key)
      }
      try { acknowledge(pin) } catch { error.value = storageError }
    } catch (value) {
      if (!valid(scope)) return
      if (value instanceof HttpError && value.status === 404) {
        try { acknowledge(pin) } catch { error.value = storageError }
      } else error.value = 'Some old pins are waiting to sync. Reconnect or Retry pins; your backup is kept.'
    } finally {
      busy.value.delete(key); revision++
      if (scope !== generation && valid(generation) && key === operationKey(pin) && pin.profile === resolvedProfile.value) void refresh(true)
    }
  }
  async function refresh(importLegacy = false, allowReimport = false) {
    const scope = generation, sequence = ++refreshSequence, version = revision
    if (!valid(scope)) return
    if (importLegacy) { migrationRequested = true; reimportRequested ||= allowReimport; error.value = '' }
    try {
      if (!resolvedProfile.value) {
        const result = await api.request<{ current?: string }>('/api/profiles/active')
        if (!valid(scope)) return
        if (!result.current) throw new Error('Profile is unavailable')
        resolvedProfile.value = result.current
        loadLegacy()
      }
      const page = await api.sessions(resolvedProfile.value)
      if (!valid(scope) || sequence !== refreshSequence) return
      if (!Array.isArray(page.sessions) || Object.values(page.storage || {}).includes('corrupt')) throw new Error('Pin list is unavailable')
      if (version === revision && !busy.value.size) {
        for (const row of Object.values(details.value)) row.pinned = false
        for (const row of page.sessions) if (row.profile === resolvedProfile.value) details.value[conversationKey(row)] = { ...row }
      }
      if (migrationRequested) {
        const retryAttempted = reimportRequested
        migrationRequested = false; reimportRequested = false
        loadLegacy()
        for (const pin of [...legacy.value]) {
          if (!valid(scope)) return
          await importPin(pin, scope, retryAttempted)
        }
      }
    } catch { if (valid(scope)) error.value = 'Could not refresh pins. Reconnect or Retry pins; old pins are kept.' }
  }
  async function toggle(session: Pick<SessionRow, 'id' | 'profile'>) {
    const pin = { id: session.id, profile: session.profile || resolvedProfile.value }
    const scope = generation, key = operationKey(pin)
    if (!pin.id || !pin.profile || !valid(scope) || isBusy(pin)) return
    const migrating = legacyFor(pin)
    const before = rowFor(pin), desired = !isPinned(pin)
    if (migrating.length) {
      try { for (const reference of migrating) recordAttempt(reference) } catch { error.value = storageError; return }
    }
    busy.value.add(key); revision++
    error.value = ''
    details.value[conversationKey(pin)] = { ...before, ...pin, pinned: desired }
    try {
      await api.setPinned(pin.id, desired, pin.profile)
      if (!valid(scope)) return
      const row = await api.session(pin.id, pin.profile)
      if (!valid(scope)) return
      if (nativePinned(row) !== desired) throw new Error('Pin was not confirmed')
      store(row, pin)
      for (const reference of migrating) {
        confirmed.add(operationKey(reference))
        try { acknowledge(reference) } catch { error.value = storageError }
      }
    } catch {
      if (!valid(scope)) return
      if (before) details.value[conversationKey(pin)] = before
      else delete details.value[conversationKey(pin)]
      error.value = 'Could not confirm the pin change. Retry pins to check Hermes before trying again.'
    } finally { busy.value.delete(key); revision++ }
  }
  function remove(session: Pick<SessionRow, 'id' | 'profile'>) {
    const pin = { id: session.id, profile: session.profile || resolvedProfile.value }
    for (const reference of legacyFor(pin)) {
      try { acknowledge(reference) } catch { error.value = storageError }
    }
    for (const [key, row] of Object.entries(details.value)) if (row.profile === pin.profile && (row.id === pin.id || row._lineage_ids?.includes(pin.id))) delete details.value[key]
    revision++
  }
  watch([endpoint, profile], () => {
    generation++; revision++; refreshSequence++; migrationRequested = false; reimportRequested = false
    details.value = {}; legacy.value = []; uncertain.value.clear(); resolvedProfile.value = profile.value || ''; error.value = ''
    loadLegacy()
    void refresh(true)
  }, { immediate: true, flush: 'sync' })
  watch(connected, value => { generation++; if (value) void refresh(true) }, { flush: 'sync' })
  watch(sessions, rows => {
    for (const row of rows) if (row.profile === resolvedProfile.value && !details.value[conversationKey(row)] && !isBusy(row)) details.value[conversationKey(row)] = { ...row }
  }, { immediate: true })
  watch([selected, connected, endpoint, resolvedProfile], async () => {
    const pin = { ...selected.value, profile: selected.value.profile || resolvedProfile.value }, scope = generation, version = revision
    if (!pin.id || !pin.profile || !valid(scope) || rowFor(pin)) return
    try {
      const row = await api.session(pin.id, pin.profile)
      if (valid(scope) && revision === version && selected.value.id === pin.id && (selected.value.profile || resolvedProfile.value) === pin.profile && !isBusy(pin)) store(row, { id: pin.id, profile: pin.profile })
    } catch { /* The chat's own history request reports unavailable selections. */ }
  }, { immediate: true })
  function focus() { void refresh() }
  function storageChanged(event: StorageEvent) { if (event.key === storageKey || event.key === null) loadLegacy() }
  window.addEventListener('focus', focus)
  window.addEventListener('storage', storageChanged)
  document.addEventListener('visibilitychange', focus)
  onBeforeUnmount(() => {
    disposed = true; generation++
    window.removeEventListener('focus', focus); window.removeEventListener('storage', storageChanged)
    document.removeEventListener('visibilitychange', focus)
  })
  function ordered(visible: SessionRow[], query: string): SessionRow[] {
    const rows = new Map(visible.map(session => [conversationKey(session), session]))
    const loaded = new Map(sessions.value.map(session => [conversationKey(session), session]))
    const matching = query.trim().toLocaleLowerCase()
    const pinned: SessionRow[] = []
    for (const pin of pins.value) {
      const key = conversationKey(pin)
      const session = rows.get(key) || loaded.get(key) || rowFor(pin) || { ...pin, title: 'Pinned chat' }
      if (matching && !rows.has(key) && !(session.title || '').toLocaleLowerCase().includes(matching) && !session.id.toLocaleLowerCase().includes(matching)) continue
      pinned.push(session); rows.delete(key)
    }
    return [...pinned, ...rows.values()]
  }
  return { pins, error, pendingCount, uncertainCount, isPinned, isBusy, toggle, remove, ordered, retry: () => refresh(true), reimport: () => refresh(true, true), refresh }
}
