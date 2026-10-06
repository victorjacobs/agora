<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { ModelProvider } from './hermes/settings'
import { quotaError, type ProviderQuota } from './hermes/quota'

const props = defineProps<{
  providers: ModelProvider[]
  currentProvider: string
  profile?: string
  connected: boolean
  load: (provider: string, profile?: string) => Promise<ProviderQuota>
}>()
const expanded = ref(false)
const selected = ref('')
const loading = ref(false)
const error = ref('')
const cache = reactive<Record<string, { value: ProviderQuota; at: number }>>({})
const available = computed(() => props.providers.filter(provider => provider.authenticated !== false))
const scope = computed(() => JSON.stringify([props.profile, selected.value]))
const result = computed(() => cache[scope.value]?.value)
let generation = 0

watch(() => [available.value, props.currentProvider], () => {
  if (!available.value.some(provider => provider.slug === selected.value)) {
    selected.value = available.value.find(provider => provider.slug === props.currentProvider)?.slug || available.value[0]?.slug || ''
  }
}, { immediate: true })

async function refresh(force = false) {
  const request = ++generation
  error.value = ''
  loading.value = false
  if (!expanded.value || !props.connected || !selected.value) return
  const key = scope.value
  if (!force && cache[key] && Date.now() - cache[key].at < 60_000) return
  loading.value = true
  try {
    const value = await props.load(selected.value, props.profile)
    if (request === generation) cache[key] = { value, at: Date.now() }
  } catch (failure) {
    if (request === generation) error.value = quotaError(failure)
  } finally { if (request === generation) loading.value = false }
}
watch(() => [expanded.value, scope.value, props.connected], () => { void refresh() })
onBeforeUnmount(() => { generation++ })
function resetTime(value: string) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
</script>

<template>
  <section class="provider-quota" aria-label="Provider quota">
    <button class="quota-toggle" :aria-expanded="expanded" aria-controls="quota-panel" @click="expanded = !expanded">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 14a8 8 0 1 1 14 0M10 10l4-4M3 14h14" /><circle cx="10" cy="10" r="1.5" /></svg>
      <span>Provider quota</span><span class="quota-chevron" aria-hidden="true">{{ expanded ? '⌄' : '⌃' }}</span>
    </button>
    <div v-if="expanded" id="quota-panel" class="quota-panel">
      <div class="quota-controls">
        <select v-model="selected" aria-label="Quota provider" :disabled="!available.length">
          <option v-if="!available.length" value="">No providers</option>
          <option v-for="provider in available" :key="provider.slug" :value="provider.slug">{{ provider.name }}</option>
        </select>
        <button class="quota-refresh" aria-label="Refresh provider quota" :disabled="loading || !connected || !selected" @click="refresh(true)">↻</button>
      </div>
      <p v-if="!connected" class="quota-note" role="status">Connect to Hermes to check quota.</p>
      <p v-else-if="loading" class="quota-note" role="status">Checking quota…</p>
      <p v-else-if="error" class="quota-note" role="status">{{ error }}</p>
      <template v-else-if="result">
        <p v-if="result.plan" class="quota-plan">{{ result.plan }}</p>
        <p v-if="result.unavailable" class="quota-note">{{ result.unavailable }}</p>
        <div v-for="(window, index) in result.windows" :key="index" class="quota-window">
          <div class="quota-window-heading"><span>{{ window.label }}</span><strong>{{ window.remaining === undefined ? 'Unavailable' : `${Math.round(window.remaining)}% left` }}</strong></div>
          <meter v-if="window.remaining !== undefined" min="0" max="100" :value="window.remaining" :aria-label="`${window.label} quota remaining`" />
          <p v-if="window.resetsAt" class="quota-note">Resets {{ resetTime(window.resetsAt) }}</p>
          <p v-else-if="window.detail" class="quota-note">{{ window.detail }}</p>
        </div>
        <p v-for="(detail, index) in result.details" :key="index" class="quota-note">{{ detail }}</p>
      </template>
      <p v-else-if="!available.length" class="quota-note">No configured providers available.</p>
    </div>
  </section>
</template>

<style scoped>
.provider-quota { width: 100%; min-width: 0; }
.quota-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 0; border: 0; background: transparent; text-align: left; color: var(--secondary-text); font-size: 12px; }
.quota-toggle svg { width: 16px; height: 16px; }
.quota-chevron { margin-left: auto; }
.quota-panel { padding-top: 10px; max-height: min(360px, 45dvh); overflow-y: auto; }
.quota-controls { display: flex; gap: 6px; margin-bottom: 12px; }
.quota-controls select { min-width: 0; font-size: 12px; padding: 6px 8px; }
.quota-refresh { padding: 3px 9px; font-size: 18px; }
.quota-plan { margin: 0 0 10px; font-size: 12px; font-weight: 550; }
.quota-window { margin: 0 0 12px; }
.quota-window-heading { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
.quota-window-heading strong { font-weight: 550; }
.quota-note { margin: 5px 0; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
meter { display: block; width: 100%; height: 6px; margin: 6px 0; background: var(--border); border: 0; border-radius: 4px; appearance: none; }
meter::-webkit-meter-bar { background: var(--border); border: 0; border-radius: 4px; }
meter::-webkit-meter-optimum-value { background: var(--primary); border-radius: 4px; }
meter::-moz-meter-bar { background: var(--primary); border-radius: 4px; }
</style>
