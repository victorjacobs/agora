<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status?: 'working' | 'waiting'; processCount: number; unread: boolean; pinned?: boolean }>()
const processLabel = computed(() => props.processCount === 1 ? 'Background process running' : `${props.processCount} background processes running`)
</script>

<template>
  <span v-if="status || processCount || unread || pinned" class="conversation-indicators">
    <span v-if="unread" class="unread-reply" role="img" aria-label="Unread response" title="Unread response"></span>
    <span v-if="status === 'waiting'" class="session-indicator waiting" role="img" aria-label="Waiting for input" title="Waiting for input"></span>
    <svg v-else-if="status === 'working'" class="session-indicator" viewBox="0 0 24 24" role="img" aria-label="Running"><title>Running</title><path class="stationary-running" d="m7 4 13 8-13 8Z" /></svg>
    <svg v-if="processCount" class="session-process-indicator" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" role="img" :aria-label="processLabel"><title>{{ processLabel }}</title><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>
    <svg v-if="pinned" class="session-pin-indicator" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pinned conversation"><title>Pinned conversation</title><path d="m16 3 5 5-3 1-4 4-1 4-6-6 4-1 4-4 1-3ZM9 15l-6 6" /></svg>
  </span>
</template>

<style scoped>
.conversation-indicators { display: inline-flex; align-items: center; gap: 9px; flex-shrink: 0; }
.stationary-running { display: none; }
.session-pin-indicator { width: 16px; height: 16px; flex-shrink: 0; color: var(--primary); }
@media (prefers-reduced-motion: reduce) {
  .session-indicator:not(.waiting) { width: 14px; height: 14px; border: 0; border-radius: 0; color: var(--primary); }
  .stationary-running { display: block; fill: currentColor; }
}
</style>
