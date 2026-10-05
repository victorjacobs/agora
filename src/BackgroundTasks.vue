<script setup lang="ts">
import { computed } from 'vue'
import { taskRunning, type BackgroundTask } from './hermes/tasks'

const props = defineProps<{ tasks: BackgroundTask[]; error: string; connected: boolean }>()
const active = computed(() => props.tasks.filter(taskRunning).length)
const labels: Record<string, string> = {
  queued: 'Queued', running: 'Running', working: 'Running', starting: 'Starting',
  completed: 'Completed', failed: 'Failed', error: 'Failed', timeout: 'Timed out',
  interrupted: 'Interrupted', unknown: 'No longer in live roster',
}
</script>

<template>
  <section v-if="tasks.length || error" class="background-tasks" aria-label="Background tasks">
    <header><h2>Background tasks</h2><span v-if="active" role="status">{{ active }} running</span></header>
    <p v-if="error || !connected" class="task-notice" role="status">{{ !connected ? 'Reconnecting. Task status may have changed.' : error }}</p>
    <ul v-if="tasks.length">
      <li v-for="task in tasks" :key="task.key">
        <div class="task-heading">
          <span class="task-indicator" :class="{ running: taskRunning(task) && connected, failed: ['failed', 'error', 'timeout'].includes(task.status) }" aria-hidden="true"></span>
          <strong>{{ task.goal }}</strong>
          <span class="task-status">{{ labels[task.status] || task.status }}</span>
        </div>
        <p v-if="task.model || task.toolCount !== undefined || task.tool || task.parentId" class="task-meta">
          <span v-if="task.parentId && tasks.some(row => row.key === task.parentId)">Nested task</span>
          <span v-if="task.model">{{ task.model }}</span>
          <span v-if="task.toolCount !== undefined">{{ task.toolCount }} tool {{ task.toolCount === 1 ? 'call' : 'calls' }}</span>
          <span v-if="task.tool">{{ task.tool }}</span>
        </p>
        <details v-if="task.summary"><summary>{{ ['failed', 'error', 'timeout'].includes(task.status) ? 'Error details' : 'Result' }}</summary><pre>{{ task.summary }}</pre></details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.background-tasks { margin: 20px 0; padding: 16px 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2 { margin: 0; font-size: 14px; font-weight: 650; }
header > span, .task-notice, .task-status, .task-meta, summary { font-size: 12px; color: var(--muted); }
ul { list-style: none; padding: 0; margin: 12px 0 0; }
li + li { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
.task-heading { display: flex; align-items: baseline; gap: 9px; }
strong { flex: 1; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.task-status { flex-shrink: 0; }
.task-indicator { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.task-indicator.running { background: transparent; border: 2px solid var(--border); border-top-color: var(--primary); animation: task-spin 1s linear infinite; }
.task-indicator.failed { background: var(--error); }
.task-meta { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 0 18px; }
summary { cursor: pointer; margin: 8px 0 0 18px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; font-size: 12px; margin: 10px 0 0 18px; }
@keyframes task-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .task-indicator.running { animation: none; } }
@media (max-width: 600px) { .task-heading { flex-wrap: wrap; } .task-status { margin-left: 18px; } }
</style>
