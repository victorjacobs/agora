<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import MemoryApprovalCard from './MemoryApprovalCard.vue'
import type { MemoryApproval, MemoryPending } from './hermes/memory'
const props = defineProps<{
  active: boolean; runtime: string; profile?: string; connected: boolean
  approvals: MemoryApproval[]; disabled: boolean
  load: (runtime: string, profile?: string) => Promise<MemoryPending>
}>()
defineEmits<{ decide: [approval: MemoryApproval, choice: string] }>()
const pending = ref<MemoryPending>()
const loading = ref(false)
const error = ref('')
let generation = 0
async function refresh() {
  const request = ++generation
  pending.value = undefined
  error.value = ''
  loading.value = false
  if (!props.active || !props.runtime || !props.connected) return
  loading.value = true
  try {
    const result = await props.load(props.runtime, props.profile)
    if (request === generation) pending.value = result
  } catch (failure) {
    if (request === generation) error.value = failure instanceof Error ? failure.message : 'Could not load pending memory changes.'
  } finally { if (request === generation) loading.value = false }
}
watch(() => [props.active, props.runtime, props.profile, props.connected], () => { void refresh() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <section class="memory-view" aria-label="Memory review" tabindex="0">
    <div class="memory-width">
      <div class="memory-intro"><div><h2>Pending updates</h2><p>Review changes before Hermes remembers them.</p></div><button :disabled="loading || !runtime || !connected" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button></div>
      <p v-if="!connected" class="memory-notice" role="status">Connect to Hermes to review memory.</p>
      <p v-else-if="!runtime" class="memory-notice">Open a conversation to review memory for its profile.</p>
      <MemoryApprovalCard v-for="approval in approvals" :key="approval.key" :approval="approval" :disabled="disabled" @decide="$emit('decide', approval, $event)" />
      <p v-if="loading" class="memory-notice" role="status">Checking pending changes…</p>
      <p v-if="error" class="memory-notice" role="alert">{{ error }}</p>
      <template v-if="pending?.previews.length">
        <h3>Staged changes <span>{{ pending.previews.length }}</span></h3>
        <p class="memory-notice">Hermes exposes only previews for these changes, so they cannot be approved here. Full proposals are not available through its current API.</p>
        <article v-for="preview in pending.previews" :key="preview.id" class="memory-preview">
          <div class="preview-heading"><span>{{ preview.background ? 'Background review' : 'Staged update' }}</span><code>{{ preview.id }}</code></div>
          <p>{{ preview.summary }}</p>
          <details v-if="preview.targetDetails"><summary>Target entries</summary><div class="preview-details">{{ preview.targetDetails }}</div></details>
          <span class="preview-label">Preview only</span>
        </article>
      </template>
      <div v-else-if="pending && !approvals.length && !loading" class="memory-empty"><h3>No memory updates to review</h3><p>New memory approval requests appear here and in the chat.</p></div>
    </div>
  </section>
</template>

<style scoped>
.memory-view { flex: 1; min-height: 0; overflow-y: auto; padding: 32px; }
.memory-width { max-width: 790px; margin: 0 auto; }
.memory-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
.memory-intro h2 { margin: 0; font-size: 21px; font-weight: 550; }
.memory-intro p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.memory-intro button { font-size: 12px; }
.memory-notice { font-size: 13px; color: var(--muted); line-height: 1.6; margin: 0 0 20px; }
h3 { font-size: 14px; font-weight: 550; }
h3 span { margin-left: 6px; color: var(--muted); }
.memory-preview { padding: 18px; border: 1px solid var(--border); border-radius: 10px; margin: 14px 0; background: var(--panel); }
.preview-heading { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 11px; }
.memory-preview p, .preview-details { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.memory-preview summary { cursor: pointer; font-size: 12px; color: var(--secondary-text); }
.preview-details { padding: 12px 0; }
.preview-label { font-size: 10px; color: var(--muted); }
.memory-empty { text-align: center; padding: 50px 0; color: var(--muted); }
.memory-empty p { font-size: 13px; }
@media (max-width: 760px) { .memory-view { padding: 24px 17px; } .memory-intro h2 { font-size: 18px; } }
</style>
