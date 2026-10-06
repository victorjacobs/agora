<script setup lang="ts">
import { computed } from 'vue'
import { approvalChoices, approvalLabels } from './hermes/approvals'
import type { Approval } from './hermes/types'

const props = defineProps<{ approval: Approval; disabled: boolean }>()
defineEmits<{ decide: [choice: string] }>()
const choices = computed(() => approvalChoices(props.approval))
const rememberedChoices = computed(() => choices.value.filter(choice => choice === 'session' || choice === 'always'))
const canReview = computed(() => Boolean(props.approval.command?.trim()))
</script>

<template>
  <section class="command-approval" aria-label="Command approval">
    <header><h3>Allow this command?</h3><span>Needs approval</span></header>
    <p v-if="approval.description">{{ approval.description }}</p>
    <pre v-if="canReview"><code>{{ approval.command }}</code></pre>
    <p v-else class="muted">Hermes did not provide the command to review.</p>
    <p v-if="approval.smart_denied" class="muted">Hermes flagged this command. Review it before allowing it.</p>
    <div class="approval-actions">
      <button v-if="choices.includes('deny')" type="button" :disabled="disabled" @click="$emit('decide', 'deny')">Reject</button>
      <button v-if="choices.includes('once')" type="button" class="primary" :disabled="disabled || !canReview" @click="$emit('decide', 'once')">Allow once</button>
      <details v-if="rememberedChoices.length" class="approval-more">
        <summary>More options</summary>
        <div><p>Remember approval for matching commands:</p>
          <button v-for="choice in rememberedChoices" :key="choice" type="button" :disabled="disabled || !canReview" @click="$emit('decide', choice)">{{ approvalLabels[choice] }}</button>
        </div>
      </details>
    </div>
    <p v-if="!choices.length" class="muted">Hermes offered no supported approval choices.</p>
  </section>
</template>

<style scoped>
.command-approval { border: 1px solid var(--selected-border); border-radius: 10px; background: var(--panel); padding: 16px; margin-bottom: 16px; }
.command-approval header { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
.command-approval h3 { margin: 0; font-size: 14px; }
.command-approval header span { color: var(--muted); font-size: 11px; white-space: nowrap; }
.command-approval p { font-size: 12px; line-height: 1.6; margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.command-approval pre { margin: 12px 0; padding: 12px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
.approval-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.approval-more { font-size: 12px; color: var(--muted); }
.approval-more summary { cursor: pointer; padding: 8px; }
.approval-more[open] { flex-basis: 100%; }
.approval-more div { padding: 0 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.approval-more p { width: 100%; margin: 4px 0; }
</style>
