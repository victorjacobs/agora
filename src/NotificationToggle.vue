<script setup lang="ts">
import { computed } from 'vue'
import type { notificationState } from './reply-notifications'
const props = defineProps<{ state: ReturnType<typeof notificationState> }>()
defineEmits<{ toggle: [] }>()
const enabled = computed(() => props.state.pushEnabled || props.state.enabled)
const push = computed(() => props.state.pushConfigured && props.state.pushSupported)
const diagnosticHelp = computed(() => Boolean(props.state.help) && (!props.state.pushSupported || !props.state.pushConfigured || props.state.pushStatus === 'unavailable'))
const label = computed(() => props.state.busy ? 'Updating notifications…' : props.state.pushEnabled ? (props.state.pushStatus.includes('unavailable') ? 'Push unavailable' : 'Background notifications on') : props.state.enabled ? 'Desktop notifications on' : 'Notifications off')
</script>

<template>
  <div class="notification-control">
    <button class="sidebar-action notification-toggle" :disabled="state.busy || (!state.supported && !push && !state.pushEnabled)" :aria-pressed="enabled" :aria-label="enabled ? 'Disable response notifications' : 'Enable response notifications'" :title="push ? 'Background replies and attention requests on this device' : 'Desktop-only notifications while Agora stays open'" @click="$emit('toggle')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg><span><strong>Notifications</strong><small>{{ label }}</small></span><span class="notification-switch" aria-hidden="true"><span></span></span></button>
    <p class="notification-summary">{{ push || state.pushEnabled ? 'Replies and attention requests on this device. Titles and short previews may appear on the lock screen.' : 'Reply notifications while Agora stays open and connected.' }}</p>
    <details><summary>Details</summary><p>{{ push || state.pushEnabled ? 'Only conversations opened in Agora are watched. Secure input requests stay generic. Delivery is best-effort, not a guaranteed alert.' : 'Desktop-only notifications need a supported browser and HTTPS or localhost. Background delivery requires operator-configured Web Push.' }}</p><p v-if="state.help && !diagnosticHelp">{{ state.help }}</p><p v-if="state.pushStatus">Watcher: {{ state.pushStatus }}</p></details>
    <p v-if="diagnosticHelp" role="status">{{ state.help }}</p>
    <p v-else-if="state.pushEnabled && state.pushStatus !== 'watching'" role="status">Watcher: {{ state.pushStatus || 'connecting' }}. Delivery may be delayed or unavailable.</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
  </div>
</template>

<style scoped>
strong, small { display: block; }
strong { font-size: 15px; font-weight: 550; color: var(--text); }
small { margin-top: 3px; font-size: 12px; color: var(--muted); }
.notification-toggle { gap: 14px; font-size: 14px; }
.notification-toggle svg { width: 24px; height: 24px; color: var(--link); }
.notification-switch { flex-shrink: 0; margin-left: auto; width: 40px; height: 24px; padding: 3px; border-radius: 14px; background: var(--border-strong); }
.notification-switch span { display: block; width: 18px; height: 18px; border-radius: 50%; background: var(--text); }
[aria-pressed=true] .notification-switch { background: var(--primary); }
[aria-pressed=true] .notification-switch span { margin-left: 16px; background: var(--on-primary); }
details { font-size: 12px; color: var(--muted); margin-top: 6px; }
summary { cursor: pointer; color: var(--link); text-decoration: underline; }
.notification-control { width: 100%; }
p { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
</style>
