<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ChatClient, initialState } from './hermes/chat'
import { renderMarkdown } from './markdown'
import RequestCard from './RequestCard.vue'
import type { Approval, SessionRow } from './hermes/types'

const state = reactive(initialState())
const chat = new ChatClient(state)
const sidebarOpen = ref(false)
const menuButton = ref<HTMLButtonElement>()
const closeMenuButton = ref<HTMLButtonElement>()
const transcript = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const following = ref(true)
const dialog = ref<HTMLDialogElement>()
const dialogKind = ref<'rename' | 'delete'>('rename')
const newTitle = ref('')
const mutationPending = ref(false)
const displayedRequests = computed(() => state.requests)
const displayedApprovals = computed(() => state.approvals.filter(approval =>
  !state.requests.some(request => request.method === 'approval' && request.params.request_id === approval.request_id),
))
const status = computed(() => ({
  connecting: 'Connecting', recovering: 'Recovering conversation', ready: state.sending ? 'Sending' : state.running ? 'Running' : 'Connected',
  reconnecting: 'Reconnecting', expired: 'Sign-in required', failed: 'Connection failed', closed: 'Disconnected',
})[state.connection])
const actionsDisabled = computed(() => state.connection !== 'ready' || state.actionPending || mutationPending.value)
const loginUrl = computed(() => `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)

async function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
  await nextTick()
  if (sidebarOpen.value) closeMenuButton.value?.focus()
  else menuButton.value?.focus()
}

function selectSession(session: SessionRow) {
  sidebarOpen.value = false
  following.value = true
  void chat.open(session.id, session.profile || import.meta.env.VITE_HERMES_PROFILE || undefined)
}

function trackScroll() {
  const element = transcript.value
  if (element) following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 100
}

async function scrollToLatest(force = true) {
  await nextTick()
  if (!force && !following.value) return
  if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
  following.value = true
}

async function loadOlder() {
  const element = transcript.value
  const height = element?.scrollHeight || 0
  const top = element?.scrollTop || 0
  following.value = false
  await chat.older()
  await nextTick()
  if (element) element.scrollTop = top + element.scrollHeight - height
}

async function send() {
  if (!state.runtime && state.connection === 'ready' && state.draft.trim()) {
    const draft = state.draft
    await chat.newChat()
    state.draft = draft
  }
  if (!chat.canSend()) return
  following.value = true
  await chat.send()
  composer.value?.focus()
}

function composerKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() }
}

function showDialog(kind: 'rename' | 'delete') {
  dialogKind.value = kind
  newTitle.value = state.title
  dialog.value?.showModal()
}

async function mutate() {
  mutationPending.value = true
  if (dialogKind.value === 'rename') await chat.rename(newTitle.value)
  else await chat.deleteSelected()
  mutationPending.value = false
  dialog.value?.close()
}

function approvalChoices(approval: Approval) {
  return approval.choices || ['once', ...(approval.allow_session ? ['session'] : []), ...(approval.allow_permanent ? ['always'] : []), 'deny']
}
const approvalLabels: Record<string, string> = { once: 'Allow once', session: 'Allow for session', always: 'Always allow', deny: 'Deny' }

function logout(event: Event) {
  event.preventDefault()
  chat.dispose()
  Object.assign(state, initialState(), { connection: 'closed' })
  const form = event.target as HTMLFormElement
  form.submit()
}

watch(() => [state.messages.length, state.messages.at(-1)?.text], () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch(() => state.selected, () => { following.value = true })
onMounted(() => { void chat.start(import.meta.env.VITE_HERMES_PROFILE) })
onBeforeUnmount(() => chat.dispose())
</script>

<template>
  <div class="shell" @keydown.esc="sidebarOpen && toggleSidebar()">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="Close conversation list" @click="toggleSidebar()"></button>
    <aside class="sidebar" :class="{ open: sidebarOpen }" aria-label="Conversations">
      <div class="brand"><span class="brand-mark" aria-hidden="true">a</span><div>agora<small>YOUR HERMES, IN CONVERSATION</small></div><button ref="closeMenuButton" class="mobile-close text-button" aria-label="Close conversations" @click="toggleSidebar()">×</button></div>
      <button class="new-chat" :disabled="actionsDisabled" @click="sidebarOpen = false; following = true; chat.newChat()"><span aria-hidden="true">＋</span> New conversation</button>
      <div class="list-heading"><span>CONVERSATIONS</span><button class="text-button" :disabled="state.listLoading || state.connection === 'expired'" @click="chat.refreshSessions()" aria-label="Refresh conversations">↻</button></div>
      <nav class="session-list" aria-label="Session history">
        <p v-if="state.listLoading && !state.sessions.length" class="muted">Loading conversations…</p>
        <div v-if="state.listError" class="list-error" role="alert"><p>{{ state.listError }}</p><button @click="chat.refreshSessions()">Try again</button></div>
        <p v-else-if="!state.listLoading && !state.sessions.length" class="muted">Your conversations will appear here.</p>
        <button v-for="session in state.sessions" :key="session.id" class="session" :class="{ selected: session.id === state.selected }" :aria-current="session.id === state.selected ? 'page' : undefined" :disabled="['connecting', 'reconnecting', 'expired', 'closed'].includes(state.connection)" @click="selectSession(session)">
          <span class="session-title">{{ session.title || 'Untitled conversation' }}</span>
          <span class="session-preview">{{ session.preview || 'Open conversation' }}</span>
        </button>
        <button v-if="state.sessions.length < state.total" class="load-more" :disabled="state.listLoading" @click="chat.refreshSessions(true)">{{ state.listLoading ? 'Loading…' : 'Load more conversations' }}</button>
      </nav>
      <div class="sidebar-footer">
        <div class="identity"><span class="status-dot" :class="state.connection"></span><span>{{ state.identity || 'Hermes dashboard' }}</span></div>
        <form v-if="state.authRequired && state.connection !== 'expired'" method="post" action="/auth/logout" @submit="logout"><button class="text-button">Sign out</button></form>
        <a href="/" target="_blank" rel="noopener">Dashboard ↗</a>
      </div>
    </aside>

    <main :inert="sidebarOpen">
      <header class="conversation-header">
        <button ref="menuButton" class="mobile-menu" aria-label="Open conversations" :aria-expanded="sidebarOpen" @click="toggleSidebar()">☰</button>
        <div class="conversation-heading"><h1>{{ state.title }}</h1><p class="connection-status" role="status"><span class="status-dot" :class="state.connection"></span>{{ status }}<span v-if="!state.authRequired && state.connection === 'ready'"> · authentication disabled</span></p></div>
        <div v-if="state.selected" class="header-actions">
          <button :disabled="actionsDisabled" @click="showDialog('rename')">Rename</button>
          <button :disabled="actionsDisabled || state.running || state.sending" @click="showDialog('delete')">Delete</button>
        </div>
      </header>

      <div v-if="state.connection === 'expired'" class="banner warning" role="alert"><span>{{ state.error }}</span><a class="button primary" :href="loginUrl">Sign in with Hermes</a></div>
      <div v-else-if="state.error" class="banner warning" role="alert"><span>{{ state.error }}</span><button v-if="state.connection === 'failed'" @click="chat.connect()">Retry connection</button><button v-else class="text-button" aria-label="Dismiss error" @click="state.error = ''">×</button></div>
      <div v-if="state.uncertain" class="banner warning" role="alert"><div>The last send may have reached Hermes. Check the recovered conversation before sending again. Your draft is retained.</div><button :disabled="state.connection !== 'ready'" @click="chat.acknowledgeUncertain()">I’ve checked; keep editing</button></div>

      <div ref="transcript" class="transcript" tabindex="0" aria-label="Conversation messages" @scroll="trackScroll">
        <div class="conversation-width">
          <button v-if="state.hasOlder" class="older-button" :disabled="state.olderLoading || state.connection !== 'ready'" @click="loadOlder">{{ state.olderLoading ? 'Loading…' : '↑ Load older messages' }}</button>
          <div v-if="!state.messages.length && !state.running" class="empty-conversation">
            <span class="empty-mark" aria-hidden="true">a</span>
            <p class="eyebrow">A LITTLE SPACE TO THINK</p>
            <h2>Start a conversation.</h2>
            <p>Ask a question, work through an idea,<br />or pick up where you left off.</p>
            <p class="ownership-note">Connected to your operator’s Hermes installation.</p>
          </div>
          <template v-for="message in state.messages" :key="message.key">
            <article v-if="message.role === 'user' || message.role === 'assistant'" class="message" :class="message.role">
              <div class="message-author"><span class="avatar" aria-hidden="true">{{ message.role === 'user' ? 'Y' : 'a' }}</span>{{ message.role === 'user' ? 'You' : 'Hermes' }}<span v-if="message.kind" class="message-kind">{{ message.kind.replaceAll('_', ' ') }}</span></div>
              <div v-if="message.role === 'assistant'" class="markdown" v-html="renderMarkdown(message.text)"></div>
              <div v-else class="user-text">{{ message.text }}</div>
              <span v-if="!message.text && state.running" class="thinking">Thinking…</span>
            </article>
            <details v-else-if="message.role === 'tool'" class="tool-message"><summary>Tool activity</summary><pre>{{ message.text }}</pre></details>
            <div v-else-if="message.role !== 'system'" class="muted">{{ message.text }}</div>
          </template>
          <div v-if="state.activity" class="activity" role="status"><span v-if="state.running" class="pulse" aria-hidden="true"></span>{{ state.activity }}</div>
          <RequestCard v-for="request in displayedRequests" :key="request.id" :request="request" :disabled="actionsDisabled" @answer="chat.answer(request, $event)" />
          <section v-for="approval in displayedApprovals" :key="approval.request_id || 'pending'" class="request-card">
            <h3>Approval required</h3><p>{{ approval.description }}</p><pre v-if="approval.command">{{ approval.command }}</pre>
            <div class="button-row"><button v-for="choice in approvalChoices(approval)" :key="choice" :disabled="actionsDisabled" @click="chat.approve(approval, choice)">{{ approvalLabels[choice] || choice }}</button></div>
          </section>
        </div>
      </div>
      <button v-if="!following" class="jump-latest" @click="scrollToLatest()">↓ Latest messages</button>

      <footer class="composer-footer">
        <form class="composer conversation-width" @submit.prevent="send">
          <label class="sr-only" for="prompt">Message Hermes</label>
          <textarea id="prompt" ref="composer" v-model="state.draft" rows="3" placeholder="Message Hermes…" :disabled="state.connection === 'expired' || state.connection === 'closed'" @keydown="composerKey"></textarea>
          <div class="composer-bottom"><span>Enter to send <span class="desktop-hint">· Shift + Enter for a new line</span></span>
            <button v-if="state.running" type="button" class="stop" :disabled="actionsDisabled" @click="chat.stop()">■ Stop</button>
            <button v-else class="primary send" :disabled="state.runtime ? !chat.canSend() : state.connection !== 'ready' || !state.draft.trim()" type="submit">{{ state.sending ? 'Sending…' : 'Send ↑' }}</button>
          </div>
        </form>
        <p class="composer-note">Hermes runs the agent and keeps your conversations.</p>
      </footer>
    </main>

    <dialog ref="dialog" @cancel="mutationPending && $event.preventDefault()">
      <form @submit.prevent="mutate">
        <h2>{{ dialogKind === 'rename' ? 'Rename conversation' : 'Delete conversation?' }}</h2>
        <label v-if="dialogKind === 'rename'">Title<input v-model="newTitle" autofocus required :disabled="mutationPending" /></label>
        <p v-else>“{{ state.title }}” will be deleted from Hermes. This cannot be undone.</p>
        <div class="button-row"><button type="button" :disabled="mutationPending" @click="dialog?.close()">Cancel</button><button :class="dialogKind === 'delete' ? 'danger' : 'primary'" :disabled="mutationPending" type="submit">{{ mutationPending ? 'Saving…' : dialogKind === 'rename' ? 'Save title' : 'Delete conversation' }}</button></div>
      </form>
    </dialog>
  </div>
</template>
