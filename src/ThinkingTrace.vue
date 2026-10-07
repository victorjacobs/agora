<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from './markdown'
import { openIosFirefoxLink } from './external-links'
const props = defineProps<{ text: string; active: boolean }>()
const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <details class="thinking-trace" :class="{ 'thinking-active': active }">
    <summary>
      <svg class="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      <svg class="thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.7-1.3A4 4 0 0 0 3 9a4 4 0 0 0 .5 6.5A4 4 0 0 0 7 21a3 3 0 0 0 5-2V5Zm0 0a3 3 0 0 1 5.7-1.3A4 4 0 0 1 21 9a4 4 0 0 1-.5 6.5A4 4 0 0 1 17 21a3 3 0 0 1-5-2M7 9c2 0 3 1 3 3m7-3c-2 0-3 1-3 3M7 17c0-2 1-3 3-3m7 3c0-2-1-3-3-3"/></svg>
      <span v-if="active" class="session-indicator" aria-hidden="true"></span>
      <span :role="active ? 'status' : undefined">{{ active ? 'Thinking…' : 'Thinking' }}</span>
      <span class="trace-hint">{{ text ? 'View trace' : 'Waiting for trace' }}</span>
    </summary>
    <div class="trace-body">
      <div v-if="text" class="trace-text markdown" @click="openIosFirefoxLink" v-html="html"></div>
      <p v-else>Hermes hasn’t provided a thinking trace.</p>
    </div>
  </details>
</template>

<style scoped>
.thinking-trace { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); overflow: hidden; }
summary { display: flex; align-items: center; gap: 8px; list-style: none; padding: 10px 12px; color: var(--secondary-text); font-size: 12px; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--hover); }
summary > span:first-of-type { font-weight: 550; }
.thinking-icon { width: 16px; height: 16px; flex-shrink: 0; }
.thinking-chevron { width: 14px; height: 14px; flex-shrink: 0; }
details[open] .thinking-icon { width: 16px; height: 16px; flex-shrink: 0; }
.thinking-chevron { transform: rotate(90deg); }
.trace-hint { margin-left: auto; color: var(--muted); font-size: 11px; }
.trace-body { padding: 12px; border-top: 1px solid var(--border); }
.trace-text { white-space: normal; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; font-size: 13px; line-height: 1.7; }
p { margin: 0; color: var(--muted); font-size: 12px; }
.thinking-active { border-color: var(--border-strong); }
</style>
