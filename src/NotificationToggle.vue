<script setup lang="ts">
import { computed } from 'vue'
import type { notificationState } from './reply-notifications'
const props = defineProps<{ state: ReturnType<typeof notificationState> }>()
defineEmits<{ toggle: [] }>()
const enabled = computed(() => props.state.pushEnabled || props.state.enabled)
const push = computed(() => props.state.pushConfigured && props.state.pushSupported)
const label = computed(() => props.state.busy ? 'Updating notifications…' : props.state.pushEnabled ? (props.state.pushStatus.includes('unavailable') ? 'Push unavailable' : 'Background notifications on') : props.state.enabled ? 'Desktop notifications on' : 'Notifications off')
</script>

<template>
  <div class="notification-control">
    <button class="sidebar-action notification-toggle" :disabled="state.busy || (!state.supported && !push && !state.pushEnabled)" :aria-pressed="enabled" :aria-label="enabled ? 'Disable response notifications' : 'Enable response notifications'" :title="push ? 'Background replies and attention requests on this device' : 'Desktop-only notifications while Agora stays open'" @click="$emit('toggle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg><span>{{ label }}</span></button>
    <p v-if="state.help" role="status">{{ state.help }}</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
  </div>
</template>

<style scoped>
.notification-control { width: 100%; }
p { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
</style>
