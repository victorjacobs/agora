<script setup lang="ts">
import type { Approval } from './hermes/types'
defineProps<{ approval: Approval; disabled: boolean }>()
defineEmits<{ decide: [choice: string] }>()
</script>

<template>
  <section class="memory-approval" aria-label="Memory update approval">
    <div class="memory-card-heading"><h2>Save to memory?</h2><span class="memory-badge">Needs review</span></div>
    <p v-if="approval.description" class="memory-summary">{{ approval.description.replace(/^Save to memory:\s*/i, '') }}</p>
    <div v-if="approval.command" class="memory-proposal">{{ approval.command }}</div>
    <p v-else class="memory-summary">Hermes did not provide the proposed change.</p>
    <div class="memory-actions">
      <button v-if="!approval.choices || approval.choices.includes('deny')" :disabled="disabled" @click="$emit('decide', 'deny')">Reject</button>
      <button v-if="!approval.choices || approval.choices.includes('once')" class="primary" :disabled="disabled || !approval.command" @click="$emit('decide', 'once')">Save this change</button>
    </div>
  </section>
</template>

<style scoped>
.memory-approval { padding: 20px; border: 1px solid var(--selected-border); border-radius: 12px; background: var(--surface); margin-bottom: 20px; }
.memory-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
.memory-badge { font-size: 10px; color: var(--link); white-space: nowrap; }
.memory-summary { font-size: 12px; color: var(--muted); margin: 8px 0 14px; overflow-wrap: anywhere; }
.memory-proposal { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; padding: 16px; background: var(--panel); border-radius: 8px; max-height: 50dvh; overflow-y: auto; }
.memory-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.memory-actions button { font-size: 12px; }
</style>
