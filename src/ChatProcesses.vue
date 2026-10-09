<script setup lang="ts">
import { computed } from 'vue'
import type { ChatProcess } from './hermes/processes'
const props = defineProps<{ processes: ChatProcess[]; connected: boolean; error: string; stopping: Set<string>; scope: string }>()
const running = computed(() => props.processes.filter(process => process.status === 'running').length)
const oldestRunning = computed(() => Math.max(0, ...props.processes.filter(process => process.status === 'running').map(process => process.uptime)))
defineEmits<{ stop: [id: string]; retry: [] }>()
function elapsed(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
}
</script>

<template>
  <details class="chat-processes">
    <summary><span v-if="running && connected" class="session-indicator" aria-hidden="true"></span>{{ running }} running {{ running === 1 ? 'process' : 'processes' }}<span v-if="running"> · oldest {{ elapsed(oldestRunning) }}</span><span v-if="processes.length > running"> · {{ processes.length - running }} status unknown</span></summary>
    <p v-if="error" class="process-error" role="status">{{ error }} <button :disabled="!connected" @click="$emit('retry')">Retry status</button></p>
    <div class="process-rows">
      <section v-for="process in processes" :key="process.id" class="process-row">
        <div class="process-heading">
          <code :title="process.command">{{ process.command || process.id }}</code>
          <span>{{ elapsed(process.uptime) }} · {{ connected ? process.status === 'running' ? 'Running' : 'Status unknown' : 'Disconnected' }}</span>
          <button :disabled="!connected || process.status !== 'running' || stopping.has(JSON.stringify([scope, process.id]))" :aria-label="`Stop process ${process.command || process.id}`" @click="$emit('stop', process.id)">{{ stopping.has(JSON.stringify([scope, process.id])) ? 'Stopping…' : 'Stop' }}</button>
        </div>
        <details class="process-output"><summary>View output</summary><p class="output-limit">Last 4,000 characters</p><pre>{{ process.output || 'Waiting for output…' }}</pre></details>
      </section>
    </div>
  </details>
</template>

<style scoped>
.chat-processes { margin-bottom: 8px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); font-size: 12px; min-width: 0; }
.chat-processes > summary { cursor: pointer; padding: 10px 12px; color: var(--secondary-text); }
.chat-processes > summary .session-indicator { display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: middle; }
.process-rows { max-height: min(32vh, 280px); overflow: auto; padding: 0 12px; }
.process-row { padding: 10px 0; border-top: 1px solid var(--border); min-width: 0; }
.process-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.process-heading code { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.process-heading span, .output-limit { color: var(--muted); font-size: 11px; }
.process-heading button { flex-shrink: 0; }
.process-output { margin-top: 6px; }
.process-output summary { cursor: pointer; color: var(--muted); }
.process-output pre { font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow: auto; }
.output-limit { margin: 6px 0; }
.process-error { padding: 0 12px; color: var(--muted); }
</style>
