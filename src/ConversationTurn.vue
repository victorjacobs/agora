<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationTurn } from './hermes/transcript'
import MarkdownMessage from './MarkdownMessage.vue'
import ThinkingTrace from './ThinkingTrace.vue'
import { generatedImage } from './hermes/media'
import type { Message } from './hermes/types'

const props = defineProps<{ turn: ConversationTurn; thinking: boolean; profile?: string }>()
const completionNotice = computed(() => props.turn.blocks.every(block => block.kind === 'text' && ['async_delegation_complete', 'process_complete'].includes(block.message.kind || '')))
defineEmits<{ imageLoad: [] }>()
function runningTools(messages: Message[]) { return messages.filter(message => message.tool?.status === 'running') }
function toolContext(messages: Message[]) {
  const tool = runningTools(messages).at(-1)
  return tool ? [tool.name, tool.tool?.context].filter(Boolean).join(' · ') : [...new Set(messages.map(message => message.name).filter(Boolean))].join(', ')
}
</script>

<template>
  <article class="message" :class="[turn.role, { 'completion-notice': completionNotice }]" :aria-label="turn.role === 'user' ? 'You' : turn.role === 'assistant' ? 'Hermes' : undefined">
    <div v-for="block in turn.blocks" :key="block.key" class="message-block">
      <ThinkingTrace v-if="block.kind === 'text' && (block.message.reasoning?.text || turn.role === 'assistant' && !block.message.text.trim() && thinking)" :text="block.message.reasoning?.text || ''" :active="block.message.reasoning?.active ?? thinking" />
      <template v-if="block.kind === 'tools'">
        <template v-for="tool in block.messages" :key="`image-${tool.key}`">
          <MarkdownMessage :profile="profile" v-if="generatedImage(tool.text, tool.name)" :text="`![Generated image](<${generatedImage(tool.text, tool.name)}>)`" @image-load="$emit('imageLoad')" />
        </template>
        <details class="tool-group" :class="{ 'tool-group-running': runningTools(block.messages).length }">
          <summary>
            <svg class="tool-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
            <span>{{ block.messages.length }} tool {{ block.messages.length === 1 ? 'call' : 'calls' }}</span>
            <span v-if="runningTools(block.messages).length" class="tool-running-status" role="status"><span class="tool-spinner" aria-hidden="true"></span>{{ runningTools(block.messages).length }} running</span>
            <span class="tool-names" :title="toolContext(block.messages)">{{ toolContext(block.messages) }}</span>
          </summary>
          <div class="tool-outputs">
            <section v-for="tool in block.messages" :key="tool.key" class="tool-output">
              <h3>{{ tool.name || 'Tool output' }}<span v-if="tool.tool" class="tool-call-status"><span v-if="tool.tool.status === 'running'" class="tool-spinner" aria-hidden="true"></span>{{ tool.tool.status === 'running' ? 'Running' : 'Completed' }}<template v-if="tool.tool.duration !== undefined"> · {{ tool.tool.duration.toFixed(1) }}s</template></span></h3>
              <p v-if="tool.tool?.context" class="tool-context">{{ tool.tool.context }}</p>
              <details v-if="tool.tool?.args" class="tool-arguments"><summary>Arguments</summary><pre>{{ tool.tool.args }}</pre></details>
              <p v-if="tool.tool?.summary" class="tool-context">{{ tool.tool.summary }}</p>
              <pre v-if="tool.text.trim()">{{ tool.text }}</pre>
              <p v-else class="tool-no-output">{{ tool.tool?.status === 'running' ? 'Waiting for output…' : 'No output.' }}</p>
            </section>
          </div>
        </details>
      </template>
      <details v-else-if="['async_delegation_complete', 'process_complete'].includes(block.message.kind || '')" class="tool-group task-result">
        <summary>
          <svg class="tool-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
          <span class="task-result-title" :title="String(block.message.metadata?.display_text || '')">{{ block.message.metadata?.display_text || (block.message.kind === 'process_complete' ? 'Background process finished' : 'Background tasks finished') }}</span>
        </summary>
        <div class="tool-outputs">
          <p v-if="typeof block.message.metadata?.task_count === 'number'">{{ block.message.metadata.task_count }} {{ block.message.metadata.task_count === 1 ? 'task' : 'tasks' }} · {{ block.message.metadata.completed_count ?? '—' }} completed · {{ block.message.metadata.failed_count ?? '—' }} failed</p>
          <pre>{{ block.message.text }}</pre>
        </div>
      </details>
      <section v-else-if="block.message.kind === 'slash_command'" class="command-output">
        <h3>{{ block.message.name }}</h3><pre>{{ block.message.text }}</pre>
      </section>
      <template v-else>
        <span v-if="block.message.kind" class="message-kind">{{ block.message.kind.replaceAll('_', ' ') }}</span>
        <MarkdownMessage :profile="profile" v-if="turn.role === 'assistant' && block.message.text.trim()" :text="block.message.text" @image-load="$emit('imageLoad')" />
        <div v-else-if="turn.role !== 'assistant'" :class="turn.role === 'user' ? 'user-text' : 'muted'">{{ block.message.text }}</div>

      </template>
    </div>
  </article>
</template>

<style scoped>
.command-output { border: 1px solid var(--border); border-radius: 9px; padding: 12px; background: var(--panel); }
.command-output h3 { margin: 0 0 8px; font: 550 12px ui-monospace, monospace; color: var(--muted); }
.command-output pre { margin: 0; border: 0; padding: 0; background: transparent; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font-size: 12px; }
.task-result pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; font-size: 12px; }
.message-block + .message-block { margin-top: 16px; }
.message-kind { display: inline-block; color: var(--muted); margin-bottom: 8px; }
.tool-group { border: 1px solid var(--border); border-radius: 9px; background: var(--panel); overflow: hidden; }
.tool-group > summary { display: flex; align-items: center; gap: 8px; list-style: none; padding: 10px 12px; font-size: 12px; color: var(--secondary-text); cursor: pointer; }
.tool-group > summary::-webkit-details-marker { display: none; }
.tool-group > summary:hover { background: var(--hover); }
.tool-group > summary > span:first-of-type { flex-shrink: 0; font-weight: 550; }
.tool-chevron { width: 14px; height: 14px; flex-shrink: 0; }
.tool-group[open] > summary .tool-chevron { transform: rotate(90deg); }
.tool-names { margin-left: auto; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-outputs { padding: 0 12px 12px; border-top: 1px solid var(--border); }
.tool-output { min-width: 0; padding-top: 12px; }
.tool-output + .tool-output { margin-top: 12px; border-top: 1px solid var(--border); }
.tool-output h3 { margin: 0 0 8px; font: 550 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--secondary-text); overflow-wrap: anywhere; }
.tool-output pre { margin: 0; padding: 12px; font-size: 11px; line-height: 1.6; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); border-color: var(--border); }
.tool-no-output { margin: 0; font-size: 12px; color: var(--muted); }
.message.completion-notice { margin-bottom: 12px; padding: 0; }
.task-result { background: transparent; border: 0; border-radius: 6px; }
.task-result > summary { padding: 5px 8px; font-size: 11px; }
.task-result > summary > .task-result-title:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.task-result[open] { background: var(--panel); }
.task-result[open] > summary > .task-result-title:first-of-type { white-space: normal; }
.task-result .tool-outputs { font-size: 11px; padding: 8px 12px; }
.task-result .tool-outputs p { margin: 0 0 8px; }
.task-result pre { margin: 0; padding: 10px; font-size: 11px; max-height: 180px; }

.tool-running-status, .tool-call-status { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 400; white-space: nowrap; }
.tool-call-status { margin-left: auto; }
.tool-output h3 { display: flex; align-items: center; gap: 8px; }
.tool-group-running { border-color: var(--muted); }
.tool-context { margin: 0 0 8px; font-size: 12px; color: var(--secondary-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-arguments { margin-bottom: 8px; }
.tool-arguments > summary { font-size: 11px; color: var(--muted); cursor: pointer; margin-bottom: 6px; }
.tool-spinner { display: inline-block; width: 10px; height: 10px; flex-shrink: 0; border: 1.5px solid var(--border); border-top-color: currentColor; border-radius: 50%; animation: tool-spin 1s linear infinite; }
@keyframes tool-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tool-spinner { animation: none; } }
</style>
