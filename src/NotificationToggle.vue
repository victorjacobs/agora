<script setup lang="ts">
import type { notificationState } from './reply-notifications'
defineProps<{ state: ReturnType<typeof notificationState> }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <div class="notification-control">
    <button class="sidebar-action notification-toggle" :disabled="state.busy || !state.supported" :aria-pressed="state.enabled" :aria-label="state.enabled ? 'Disable response notifications' : 'Enable response notifications'" :title="!state.supported ? 'Desktop notifications require HTTPS or localhost and browser support' : state.enabled ? 'Disable desktop notifications for completed responses' : 'Notify when a response finishes while Agora is in the background'" @click="$emit('toggle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg><span>{{ state.busy ? 'Requesting permission…' : state.enabled && state.permission === 'granted' ? 'Notifications on' : state.enabled ? 'Notifications blocked' : 'Notifications off' }}</span></button>
    <p v-if="state.error" role="status">{{ state.error }}</p>
  </div>
</template>

<style scoped>
.notification-control { width: 100%; }
p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
</style>
