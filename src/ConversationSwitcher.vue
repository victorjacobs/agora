<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { SessionRow } from './hermes/types'

const props = defineProps<{ sessions: SessionRow[]; query: string; loading: boolean; error: string; selected: string; limited: boolean; hasMore: boolean; moreLoading: boolean }>()
const emit = defineEmits<{ search: [query: string]; select: [session: SessionRow]; close: []; retry: []; more: [] }>()
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const active = ref(0)
let previousFocus: HTMLElement | null = null
let opened = false

async function open() {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  active.value = 0
  opened = true
  dialog.value?.showModal()
  await nextTick()
  input.value?.focus()
}

function close() { dialog.value?.close(); closed() }
function closed() {
  if (!opened || dialog.value?.open) return
  opened = false
  emit('close')
  if (previousFocus?.isConnected) previousFocus.focus()
  previousFocus = null
}

function choose(session: SessionRow) {
  emit('select', session)
  close()
}

async function move(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    const session = props.sessions[active.value]
    if (session) choose(session)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!props.sessions.length) return
    active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + props.sessions.length) % props.sessions.length
    await nextTick()
    dialog.value?.querySelector(`#switcher-option-${active.value}`)?.scrollIntoView?.({ block: 'nearest' })
  }
}

watch(() => [props.query, props.sessions.map(session => `${session.profile}:${session.id}`).join('\n')], () => {
  active.value = 0
  const list = dialog.value?.querySelector('.switcher-scroll')
  if (list) list.scrollTop = 0
}, { flush: 'post' })
defineExpose({ open, close })
</script>

<template>
  <dialog ref="dialog" class="conversation-switcher" aria-label="Switch conversation" @close="closed" @click="($event.target === dialog) && close()">
    <div class="switcher-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
      <input ref="input" type="text" role="combobox" aria-label="Find a conversation" aria-autocomplete="list" aria-expanded="true" aria-controls="switcher-results" :aria-activedescendant="sessions.length ? `switcher-option-${active}` : undefined" :value="query" placeholder="Find a conversation…" autocomplete="off" @input="$emit('search', ($event.target as HTMLInputElement).value)" @keydown="move" />
      <button type="button" class="text-button switcher-close" aria-label="Close conversation switcher" @click="close">Esc</button>
    </div>
    <div class="switcher-scroll">
      <p v-if="loading" class="switcher-notice" role="status">Searching…</p>
      <p v-if="error" class="switcher-notice" role="alert">{{ error }} <button type="button" class="text-button" @click="$emit('retry')">Try again</button></p>
      <p v-else-if="!loading && !sessions.length" class="switcher-notice" role="status">{{ query.trim() ? 'No matching chats.' : 'No conversations yet.' }}</p>
      <div id="switcher-results" role="listbox" aria-label="Conversations">
        <div v-for="(session, index) in sessions" :id="`switcher-option-${index}`" :key="`${session.profile}:${session.id}`" role="option" :aria-selected="index === active" class="switcher-option" :class="{ active: index === active }" @mouseenter="active = index" @mousedown.prevent @click="choose(session)">
          <span class="switcher-title">{{ session.title || 'Untitled conversation' }}</span>
          <span v-if="session.id === selected" class="switcher-current">Current</span>
          <span v-if="index === active" class="switcher-enter" aria-hidden="true">↵</span>
        </div>
      </div>
      <p v-if="limited" class="switcher-notice">Showing the first 100 message matches. Refine your search for more.</p>
      <button v-if="hasMore" type="button" class="switcher-more text-button" :disabled="moreLoading" @click="$emit('more')">{{ moreLoading ? 'Loading…' : 'Load more conversations' }}</button>
    </div>
    <footer class="switcher-footer"><span>↑ ↓ to navigate</span><span>↵ to open</span></footer>
  </dialog>
</template>

<style scoped>
.conversation-switcher { width: min(560px, calc(100vw - 32px)); max-width: 560px; max-height: min(560px, 75dvh); padding: 0; margin: 14dvh auto auto; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0004; overflow: hidden; }
.conversation-switcher::backdrop { background: var(--backdrop); backdrop-filter: blur(3px); }
.switcher-search { display: flex; align-items: center; gap: 12px; padding: 17px 18px; border-bottom: 1px solid var(--border); }
.switcher-search svg { width: 20px; height: 20px; color: var(--muted); flex-shrink: 0; }
.switcher-search input { flex: 1; min-width: 0; padding: 0; margin: 0; border: 0; border-radius: 0; background: transparent; color: var(--text); font-size: 15px; outline: none; }
.switcher-close { font-size: 11px; color: var(--muted); }
.switcher-scroll { max-height: min(410px, calc(75dvh - 115px)); overflow-y: auto; padding: 6px; }
.switcher-option { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.switcher-option.active { background: var(--selected); }
.switcher-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.switcher-current, .switcher-enter { color: var(--muted); font-size: 11px; }
.switcher-enter { font-size: 16px; }
.switcher-notice { padding: 8px 12px; margin: 0; font-size: 12px; color: var(--muted); }
.switcher-more { margin: 4px 8px; font-size: 12px; color: var(--muted); }
.switcher-footer { display: flex; gap: 18px; padding: 10px 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
</style>
