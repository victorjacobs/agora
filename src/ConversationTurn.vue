<script setup lang="ts">
import type { ConversationTurn } from './hermes/transcript'
import MarkdownMessage from './MarkdownMessage.vue'
import { generatedImage } from './hermes/media'

defineProps<{ turn: ConversationTurn; thinking: boolean }>()
defineEmits<{ imageLoad: [] }>()
</script>

<template>
  <article class="message" :class="turn.role">
    <div v-if="turn.role !== 'other'" class="message-author"><span class="avatar" aria-hidden="true">{{ turn.role === 'user' ? 'Y' : 'a' }}</span>{{ turn.role === 'user' ? 'You' : 'Hermes' }}</div>
    <div v-for="block in turn.blocks" :key="block.key" class="message-block">
      <template v-if="block.kind === 'tools'">
        <template v-for="tool in block.messages" :key="`image-${tool.key}`">
          <MarkdownMessage v-if="generatedImage(tool.text, tool.name)" :text="`![Generated image](<${generatedImage(tool.text, tool.name)}>)`" @image-load="$emit('imageLoad')" />
        </template>
        <details class="tool-group">
          <summary>
            <svg class="tool-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
            <span>{{ block.messages.length }} tool {{ block.messages.length === 1 ? 'call' : 'calls' }}</span>
            <span class="tool-names">{{ [...new Set(block.messages.map(message => message.name).filter(Boolean))].join(', ') }}</span>
          </summary>
          <div class="tool-outputs">
            <section v-for="tool in block.messages" :key="tool.key" class="tool-output">
              <h3>{{ tool.name || 'Tool output' }}</h3>
              <pre v-if="tool.text.trim()">{{ tool.text }}</pre>
              <p v-else class="tool-no-output">No output.</p>
            </section>
          </div>
        </details>
      </template>
      <details v-else-if="['async_delegation_complete', 'process_complete'].includes(block.message.kind || '')" class="tool-group task-result">
        <summary>{{ block.message.metadata?.display_text || (block.message.kind === 'process_complete' ? 'Background process finished' : 'Background tasks finished') }}</summary>
        <div class="tool-outputs">
          <p v-if="typeof block.message.metadata?.task_count === 'number'">{{ block.message.metadata.task_count }} {{ block.message.metadata.task_count === 1 ? 'task' : 'tasks' }} · {{ block.message.metadata.completed_count ?? '—' }} completed · {{ block.message.metadata.failed_count ?? '—' }} failed</p>
          <pre>{{ block.message.text }}</pre>
        </div>
      </details>
      <template v-else>
        <span v-if="block.message.kind" class="message-kind">{{ block.message.kind.replaceAll('_', ' ') }}</span>
        <MarkdownMessage v-if="turn.role === 'assistant' && block.message.text.trim()" :text="block.message.text" @image-load="$emit('imageLoad')" />
        <div v-else-if="turn.role !== 'assistant'" :class="turn.role === 'user' ? 'user-text' : 'muted'">{{ block.message.text }}</div>
        <span v-else-if="thinking" class="thinking">Thinking…</span>
      </template>
    </div>
  </article>
</template>

<style scoped>
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
</style>
