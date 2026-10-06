<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { SavedMemoryEntry } from './hermes/memory-state'
const props = defineProps<{
  entry: SavedMemoryEntry; profile: string; disabled?: boolean
  load: (id: string, profile: string) => Promise<string>
  mutate: (id: string, profile: string, content?: string) => Promise<void>
}>()
const emit = defineEmits<{ busy: [value: boolean]; changed: [action: string] }>()
const opened = ref(false)
const loading = ref(false)
const pending = ref(false)
const mode = ref<'read' | 'edit' | 'delete'>('read')
const content = ref<string>()
const draft = ref('')
const error = ref('')
const canMutate = computed(() => /^memory:(memory|profile):\d+:[a-f\d]+$/.test(props.entry.id))
let generation = 0
async function read(action: 'read' | 'edit' | 'delete' = 'read') {
  if (pending.value || props.disabled) return
  opened.value = true
  mode.value = action
  loading.value = true
  error.value = ''
  content.value = undefined
  const request = ++generation
  try {
    const result = await props.load(props.entry.id, props.profile)
    if (request === generation) { content.value = result; draft.value = result }
  } catch (failure) {
    if (request === generation) error.value = failure instanceof Error ? failure.message : 'Could not read this entry.'
  } finally { if (request === generation) loading.value = false }
}
function cancel() { mode.value = 'read'; error.value = ''; draft.value = content.value || ''; emit('busy', false) }
async function save() {
  if (pending.value || props.disabled || content.value === undefined || !canMutate.value || mode.value === 'read') return
  if (mode.value === 'edit' && (!draft.value.trim() || draft.value === content.value)) return
  const request = generation
  const action = mode.value
  const id = props.entry.id
  const profile = props.profile
  pending.value = true
  error.value = ''
  emit('busy', true)
  try {
    await props.mutate(id, profile, action === 'edit' ? draft.value : undefined)
    if (request === generation) emit('changed', action)
  } catch (failure) {
    if (request === generation) error.value = failure instanceof Error ? failure.message : 'Could not confirm the change. Refresh the list before trying again.'
  } finally {
    if (request === generation) { pending.value = false; emit('busy', false) }
  }
}
watch(() => [props.entry.id, props.profile, props.entry.preview], () => {
  generation++; opened.value = false; loading.value = false; pending.value = false; content.value = undefined; error.value = ''; mode.value = 'read'; draft.value = ''
})
onBeforeUnmount(() => { generation++; emit('busy', false) })
</script>

<template>
  <article class="saved-memory-entry">
    <h3>{{ entry.title }}</h3>
    <template v-if="opened">
      <p v-if="loading" class="entry-status" role="status">Loading full entry…</p>
      <template v-else-if="content !== undefined">
        <label v-if="mode === 'edit'" class="edit-label">Memory text<textarea v-model="draft" aria-label="Memory text" :disabled="pending" rows="7" /></label>
        <div v-else class="entry-content">{{ content }}</div>
        <p v-if="mode === 'delete'" class="delete-notice">Delete this memory from {{ entry.id.startsWith('memory:profile:') ? 'your user profile' : 'saved memory' }}?</p>
      </template>
      <p v-if="error" class="entry-status" role="alert">{{ error }} <button v-if="content === undefined" :disabled="disabled" @click="read(mode)">Try again</button></p>
      <div v-if="mode !== 'read'" class="entry-actions">
        <button v-if="mode === 'edit'" class="primary" :disabled="disabled || pending || loading || content === undefined || !draft.trim() || draft === content" @click="save">{{ pending ? 'Saving…' : 'Save changes' }}</button>
        <button v-else class="danger" :disabled="disabled || pending || loading || content === undefined" @click="save">{{ pending ? 'Deleting…' : 'Delete memory' }}</button>
        <button :disabled="pending" @click="cancel">Cancel</button>
      </div>
      <div v-else class="entry-actions">
        <button class="text-button" :disabled="disabled || loading" @click="opened = false">Collapse</button>
        <button v-if="canMutate" :disabled="disabled || loading" @click="read('edit')">Edit</button>
        <button v-if="canMutate" class="danger" :disabled="disabled || loading" @click="read('delete')">Delete</button>
      </div>
    </template>
    <template v-else>
      <p v-if="entry.preview" class="entry-preview">{{ entry.preview }}</p>
      <button class="text-button" :disabled="disabled" @click="read()">Read full entry</button>
    </template>
  </article>
</template>

<style scoped>
.saved-memory-entry { border: 1px solid var(--border); border-radius: 10px; padding: 18px; background: var(--panel); margin: 14px 0; }
h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.entry-preview, .entry-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.7; }
.entry-preview { color: var(--muted); max-height: 110px; overflow: hidden; }
.entry-status, button, .delete-notice, .edit-label { font-size: 12px; }
.entry-content { margin-bottom: 12px; }
.entry-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.edit-label { display: block; color: var(--muted); }
textarea { display: block; width: 100%; min-height: 150px; max-height: 60vh; resize: vertical; margin: 8px 0 12px; font-size: 14px; line-height: 1.6; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
textarea:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.delete-notice { margin: 0 0 14px; }
</style>
