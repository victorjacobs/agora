<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CommandChoice } from './hermes/commands'

const props = defineProps<{ draft: string; scope: string; connected: boolean; load: () => Promise<CommandChoice[]> }>()
const emit = defineEmits<{ select: [command: string] }>()
const choices = ref<CommandChoice[]>([])
const loading = ref(false)
const error = ref('')
const selected = ref(0)
const dismissed = ref(false)
const query = computed(() => /^\/[^\s/]*$/.test(props.draft) ? props.draft.toLowerCase() : undefined)
const visible = computed(() => query.value !== undefined && !dismissed.value)
const matches = computed(() => choices.value.filter(choice => choice.name.toLowerCase().startsWith(query.value || '/')).slice(0, 50))
let generation = 0
let loadedScope: string | undefined
watch(() => props.draft, () => { selected.value = 0; dismissed.value = false })
watch([visible, () => props.scope, () => props.connected], async () => {
  const request = ++generation
  if (!visible.value || !props.connected) return
  if (loadedScope === props.scope) return
  choices.value = []
  loading.value = true
  error.value = ''
  try {
    const result = await props.load()
    if (request !== generation) return
    choices.value = result
    loadedScope = props.scope
  } catch (reason) {
    if (request === generation) error.value = reason instanceof Error ? reason.message : 'Could not load commands.'
  } finally { if (request === generation) loading.value = false }
}, { immediate: true })
function choose(index: number) {
  const choice = matches.value[index]
  if (choice) emit('select', `${choice.name} `)
}
function keydown(event: KeyboardEvent) {
  if (!visible.value || event.isComposing) return false
  if (event.key === 'Escape') { dismissed.value = true; event.preventDefault(); return true }
  if (!matches.value.length) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + matches.value.length) % matches.value.length
    document.getElementById(`slash-option-${selected.value}`)?.scrollIntoView?.({ block: 'nearest' })
    return true
  }
  if (event.key === 'Tab' || event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); choose(selected.value); return true }
  return false
}
const activeId = computed(() => visible.value && matches.value[selected.value] ? `slash-option-${selected.value}` : undefined)
defineExpose({ keydown, visible, activeId })
</script>

<template>
  <section v-if="visible" class="slash-picker" aria-label="Slash commands">
    <p v-if="!connected">Connect to Hermes to load commands.</p>
    <p v-else-if="loading" role="status">Loading commands…</p>
    <p v-else-if="error" role="status">{{ error }}</p>
    <template v-else>
      <div v-if="matches.length" id="slash-options" role="listbox" aria-label="Commands">
        <button v-for="(choice, index) in matches" :id="`slash-option-${index}`" :key="choice.name" type="button" role="option" :aria-selected="index === selected" :class="{ selected: index === selected }" @mousedown.prevent @click="choose(index)">
          <strong>{{ choice.name }}</strong><span>{{ choice.description }}</span>
        </button>
      </div>
      <p v-else>No matching commands. You can still run a command by name.</p>
    </template>
  </section>
</template>

<style scoped>
.slash-picker { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: 0 8px 30px #0002; padding: 6px; z-index: 5; }
.slash-picker [role=listbox] { max-height: 280px; overflow: auto; }
.slash-picker button { display: flex; align-items: baseline; gap: 16px; width: 100%; text-align: left; border: 0; background: transparent; padding: 9px 10px; border-radius: 7px; }
.slash-picker button.selected, .slash-picker button:hover { background: var(--hover); }
.slash-picker strong { flex-shrink: 0; font: 550 12px ui-monospace, monospace; }
.slash-picker span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-picker p { margin: 8px; color: var(--muted); font-size: 12px; }
</style>
