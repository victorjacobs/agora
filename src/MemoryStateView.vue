<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import MemoryEntry from './MemoryEntry.vue'
import { memorySections, type MemoryInspection, type MemoryInspectionSection } from './hermes/memory-state'
const props = defineProps<{
  active: boolean; section: MemoryInspectionSection; runtime: string; profile?: string; connected: boolean
  load: (section: MemoryInspectionSection, profile?: string) => Promise<MemoryInspection>
  read: (id: string, profile: string) => Promise<string>
  mutate: (id: string, profile: string, content?: string) => Promise<void>
}>()
const state = ref<MemoryInspection>()
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const notice = ref('')
const title = computed(() => memorySections.find(section => section.id === props.section)?.title)
let generation = 0
async function refresh() {
  const request = ++generation
  state.value = undefined
  busy.value = false
  loading.value = false
  error.value = ''
  if (!props.active || !props.connected) return
  loading.value = true
  try {
    const result = await props.load(props.section, props.profile)
    if (request === generation) state.value = result
  } catch (failure) {
    if (request === generation) error.value = failure instanceof Error ? failure.message : 'Could not inspect memory.'
  } finally { if (request === generation) loading.value = false }
}
watch(() => [props.active, props.section, props.runtime, props.profile, props.connected], () => { notice.value = ''; void refresh() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
async function changed(action: string) {
  notice.value = action === 'delete' ? 'Memory deleted.' : 'Memory updated.'
  await refresh()
}
const fileSize = (value?: number) => value === undefined ? 'Unavailable' : `${value.toLocaleString()} bytes`
</script>

<template>
  <section class="memory-state-view" :aria-label="title" tabindex="0">
    <div class="memory-state-width">
      <header><div><h2>{{ title }}</h2><p v-if="state">Profile: {{ state.profile }}<template v-if="!state.entries"> · Read only</template></p></div><button :disabled="loading || busy || !connected" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button></header>
      <p v-if="!connected" class="notice" role="status">Connect to Hermes to inspect memory.</p>
      <p v-if="loading" class="notice" role="status">Loading from Hermes…</p>
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
      <p v-if="notice && active" class="notice" role="status">{{ notice }}</p>
      <template v-if="state">
        <template v-if="state.entries">
          <p class="notice">{{ section === 'profile' ? 'Preferences and details Hermes remembers about you (USER.md).' : 'Persistent notes Hermes keeps between conversations (MEMORY.md).' }} Open an entry to read its full text.</p>
          <MemoryEntry v-for="entry in state.entries" :key="entry.id" :entry="entry" :profile="state.profile" :load="read" :mutate="mutate" :disabled="busy || !connected" @busy="busy = $event" @changed="changed" />
          <p v-if="!state.entries.length" class="notice">Hermes returned no saved entries.</p>
        </template>
        <template v-else-if="section === 'soul'">
          <p v-if="state.description" class="notice">{{ state.description }}</p>
          <p v-for="failure in state.errors" :key="failure" class="notice" role="status">{{ failure }}</p>
          <article v-if="state.soul !== undefined" class="memory-document"><h3>Soul <span>SOUL.md</span></h3><div v-if="state.soul.trim()" class="document-text">{{ state.soul }}</div><p v-else class="notice">No soul text was returned for this profile.</p></article>
          <article v-if="state.personality !== undefined" class="memory-document"><h3>Personality</h3><p>{{ state.personality === 'none' ? 'None selected' : state.personality }}</p></article>
          <article v-if="state.prompt !== undefined" class="memory-document"><h3>Custom instructions</h3><div v-if="state.prompt.trim()" class="document-text">{{ state.prompt }}</div><p v-else class="notice">No custom instructions configured.</p></article>
        </template>
        <template v-else-if="section === 'providers'">
          <article class="memory-document"><h3>Active memory provider</h3><p>{{ state.provider === 'builtin' ? 'Built-in memory' : state.provider }}</p><dl><dt>MEMORY.md</dt><dd>{{ fileSize(state.memoryBytes) }}</dd><dt>USER.md</dt><dd>{{ fileSize(state.userBytes) }}</dd></dl></article>
          <article v-for="provider in state.providers" :key="provider.name" class="memory-document"><h3>{{ provider.name }} <span v-if="provider.name === state.provider">Active</span></h3><p v-if="provider.description">{{ provider.description }}</p><dl><dt>Status</dt><dd>{{ provider.status.replaceAll('_', ' ') }}</dd><dt>Available</dt><dd>{{ provider.available ? 'Yes' : 'No' }}</dd><dt>Configured</dt><dd>{{ provider.configured ? 'Yes' : 'No' }}</dd></dl></article>
          <p class="notice">Saved memory and user-profile entries show built-in storage. External providers may keep additional memories that this API does not expose.</p>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.memory-state-view { flex: 1; min-height: 0; overflow-y: auto; padding: 32px; }
.memory-state-width { max-width: 790px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 28px; }
h2 { margin: 0; font-size: 21px; font-weight: 550; }
header p { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
button { font-size: 12px; }
.notice { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 0 0 20px; overflow-wrap: anywhere; }
.memory-document { border: 1px solid var(--border); border-radius: 10px; padding: 20px; background: var(--panel); margin: 14px 0; }
h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
h3 span { margin-left: 8px; color: var(--muted); font-size: 11px; font-weight: 400; }
.document-text, .memory-document > p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.7; }
.memory-document .notice { font-size: 13px; margin: 0; }
dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 16px; font-size: 13px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) { .memory-state-view { padding: 24px 17px; } h2 { font-size: 18px; } }
</style>
