<script setup lang="ts">
defineProps<{ pinned: boolean; disabled?: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button class="conversation-pin text-button" :class="{ pinned }" :disabled="disabled" :aria-label="pinned ? 'Unpin conversation' : 'Pin conversation'" :title="pinned ? 'Unpin conversation' : 'Pin conversation'" :aria-pressed="pinned" @click="$emit('toggle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-3 1-4 4-1 4-6-6 4-1 4-4 1-3ZM9 15l-6 6" /></svg></button>
</template>

<style scoped>
.conversation-pin { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 4px; flex-shrink: 0; color: var(--muted); }
.conversation-pin svg { width: 16px; height: 16px; }
.conversation-pin.pinned { color: var(--primary); }
.conversation-pin.pinned svg { fill: var(--selected); }
</style>
