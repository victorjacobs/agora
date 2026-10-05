<script setup lang="ts">
import { computed } from 'vue'
import type { ChatState } from './hermes/chat'
import { reasoningEfforts, type ModelChoice } from './hermes/settings'

const props = defineProps<{ state: ChatState }>()
const emit = defineEmits<{ model: [choice: ModelChoice]; reasoning: [effort: string]; confirm: []; cancel: []; retry: [] }>()
const disabled = computed(() => props.state.connection !== 'ready' || props.state.running || props.state.sending || props.state.actionPending || props.state.settingsPending || Boolean(props.state.modelConfirmation))
const key = (provider: string, model: string) => JSON.stringify([provider, model])
const current = computed(() => key(props.state.provider, props.state.model))
const currentListed = computed(() => props.state.modelProviders.some(provider => provider.slug === props.state.provider && provider.models.includes(props.state.model)))
const capability = computed(() => props.state.modelProviders.find(provider => provider.slug === props.state.provider)?.capabilities?.[props.state.model])
const reasoningTitle = computed(() => props.state.reasoningWire && props.state.reasoningWire !== props.state.reasoning ? `Hermes sends ${props.state.reasoningWire} for this model and provider.` : 'Reasoning effort for this conversation')
const labels: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

function chooseModel(event: Event) {
  const [provider, model] = JSON.parse((event.target as HTMLSelectElement).value) as [string, string]
  const select = event.target as HTMLSelectElement
  emit('model', { provider, model })
  select.value = current.value
}
function chooseReasoning(event: Event) {
  const select = event.target as HTMLSelectElement
  emit('reasoning', select.value)
  select.value = props.state.reasoning
}
</script>

<template>
  <div class="composer-settings">
    <label class="setting-control" title="Model for this conversation">
      <svg class="setting-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></svg>
      <select aria-label="Model" :value="current" :disabled="disabled || state.settingsLoading || !state.modelProviders.length" @change="chooseModel">
      <option v-if="!currentListed" :value="current" disabled>{{ state.model || (state.settingsLoading ? 'Loading…' : 'Default') }}</option>
      <optgroup v-for="provider in state.modelProviders" :key="provider.slug" :label="provider.name">
        <option v-for="model in provider.models" :key="model" :value="key(provider.slug, model)" :disabled="provider.authenticated === false || provider.unavailable_models?.includes(model)">{{ model }}</option>
      </optgroup>
      </select>
      <svg class="setting-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg>
    </label>
    <label class="setting-control" :title="reasoningTitle">
      <svg class="setting-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.7-1.3A4 4 0 0 0 3 9a4 4 0 0 0 .5 6.5A4 4 0 0 0 7 21a3 3 0 0 0 5-2V5Zm0 0a3 3 0 0 1 5.7-1.3A4 4 0 0 1 21 9a4 4 0 0 1-.5 6.5A4 4 0 0 1 17 21a3 3 0 0 1-5-2M7 9c2 0 3 1 3 3m7-3c-2 0-3 1-3 3M7 17c0-2 1-3 3-3m7 3c0-2-1-3-3-3"/></svg>
      <select aria-label="Reasoning effort" :value="state.reasoning" :disabled="disabled || state.settingsLoading || !state.reasoning || capability?.reasoning === false" @change="chooseReasoning">
      <option v-if="!reasoningEfforts.includes(state.reasoning)" :value="state.reasoning" disabled>{{ state.reasoning || 'Default' }}</option>
      <option v-for="effort in reasoningEfforts" :key="effort" :value="effort" :disabled="effort === 'none' && capability?.can_disable_reasoning === false">{{ labels[effort] }}</option>
      </select>
      <svg class="setting-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg>
    </label>
    <span v-if="state.settingsPending" class="settings-note" role="status">Applying…</span>
    <span v-else-if="state.reasoningWire && state.reasoningWire !== state.reasoning" class="settings-note" :title="reasoningTitle">Uses {{ state.reasoningWire }}</span>
  </div>
  <div v-if="state.modelConfirmation" class="settings-confirmation" role="status">
    <p>{{ state.modelConfirmation.message }}</p>
    <div class="button-row"><button type="button" :disabled="state.settingsPending || state.connection !== 'ready'" @click="$emit('confirm')">Switch model</button><button type="button" @click="$emit('cancel')">Cancel</button></div>
  </div>
  <p v-if="state.settingsError" class="settings-error" role="alert">{{ state.settingsError }} <button type="button" class="text-button" :disabled="disabled" @click="$emit('retry')">Refresh choices</button></p>
  <p v-else-if="state.settingsNotice" class="settings-note" role="status">{{ state.settingsNotice }}</p>
</template>

<style scoped>
.composer-settings { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.setting-control { position: relative; display: flex; align-items: center; gap: 7px; min-width: 0; max-width: 100%; padding: 5px 8px; border-radius: 8px; font-size: 13px; color: var(--muted); }
.setting-control:hover:has(select:not(:disabled)) { background: var(--hover); color: var(--text); }
.setting-control:has(select:disabled) { opacity: .5; }
.setting-icon { width: 18px; height: 18px; flex-shrink: 0; pointer-events: none; }
.setting-chevron { position: absolute; right: 7px; width: 14px; height: 14px; pointer-events: none; }
select { appearance: none; width: auto; max-width: 240px; min-width: 0; padding: 2px 19px 2px 0; font-size: 13px; font-weight: 550; color: inherit; background: transparent; border: 0; cursor: pointer; text-overflow: ellipsis; }
select:disabled { cursor: not-allowed; }
option, optgroup { background: var(--surface); color: var(--text); }
.settings-note, .settings-error, .settings-confirmation { font-size: 11px; color: var(--muted); }
p { margin: 0 0 8px; }
.settings-error { color: var(--warning-text); }
.settings-confirmation { padding: 10px; margin-top: 8px; border: 1px solid var(--warning-border); border-radius: 8px; background: var(--warning); color: var(--warning-text); }
.settings-confirmation .button-row { margin-top: 6px; }
.settings-confirmation button { padding: 4px 8px; font-size: 11px; }
@media (max-width: 600px) { .composer-settings { gap: 2px; } .setting-control { padding-left: 4px; gap: 5px; } select { max-width: 160px; font-size: 12px; } }
</style>
