<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from './markdown'
const props = defineProps<{ text: string; active: boolean }>()
const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <details class="thinking-trace" :class="{ 'thinking-active': active }">
    <summary>
      <svg class="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      <span v-if="active" class="session-indicator" aria-hidden="true"></span>
      <span :role="active ? 'status' : undefined">{{ active ? 'Thinking…' : 'Thinking' }}</span>
      <span class="trace-hint">{{ text ? 'View trace' : 'Waiting for trace' }}</span>
    </summary>
    <div class="trace-body">
      <div v-if="text" class="trace-text markdown" v-html="html"></div>
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
.thinking-chevron { width: 14px; height: 14px; flex-shrink: 0; }
details[open] .thinking-chevron { transform: rotate(90deg); }
.trace-hint { margin-left: auto; color: var(--muted); font-size: 11px; }
.trace-body { padding: 12px; border-top: 1px solid var(--border); }
.trace-text { white-space: normal; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; font-size: 13px; line-height: 1.7; }
p { margin: 0; color: var(--muted); font-size: 12px; }
.thinking-active { border-color: var(--border-strong); }
</style>
