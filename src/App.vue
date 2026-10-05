<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ChatClient, initialState } from './hermes/chat'
import { groupSessions } from './session-groups'
import { conversationTimeline } from './hermes/transcript'
import { taskRunning } from './hermes/tasks'
import ComposerSettings from './ComposerSettings.vue'
import BackgroundTasks from './BackgroundTasks.vue'
import ConversationTurn from './ConversationTurn.vue'
import RequestCard from './RequestCard.vue'
import SignInPage from './SignInPage.vue'
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
const currentDate = ref(new Date())
let dateTimer: ReturnType<typeof setInterval> | undefined
const searching = computed(() => Boolean(state.searchQuery.trim()))
const visibleSessions = computed(() => chat.visibleSessions())
const sessionGroups = computed(() => groupSessions(visibleSessions.value, currentDate.value))
const displayedRequests = computed(() => state.requests)
const displayedItems = computed(() => conversationTimeline(state.messages, state.tasks, state.running && !state.activity))
const runningTasks = computed(() => state.tasks.filter(taskRunning))
const displayedApprovals = computed(() => state.approvals.filter(approval =>
  !state.requests.some(request => request.method === 'approval' && request.params.request_id === approval.request_id),
))
const actionsDisabled = computed(() => state.connection !== 'ready' || state.actionPending || state.settingsPending || mutationPending.value)
const loginUrl = computed(() => `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)
const checkingSession = computed(() => !state.identity && ['connecting', 'recovering', 'reconnecting'].includes(state.connection))
const showSignIn = computed(() => !state.identity && state.connection !== 'ready')

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

function resizeComposer() {
  const input = composer.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`
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
watch(() => state.tasks.map(task => [task.key, task.status]), () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch([() => state.draft, composer], resizeComposer, { flush: 'post' })
onMounted(() => {
  void chat.start(import.meta.env.VITE_HERMES_PROFILE)
  dateTimer = setInterval(() => { currentDate.value = new Date() }, 60_000)
  window.addEventListener('resize', resizeComposer)
})
onBeforeUnmount(() => { clearInterval(dateTimer); window.removeEventListener('resize', resizeComposer); chat.dispose() })
</script>

<template>
  <main v-if="checkingSession" class="startup-page" aria-label="Loading chat">
    <span class="brand-mark" aria-hidden="true">a</span>
    <p role="status"><span class="session-indicator" aria-hidden="true"></span>Loading…</p>
    <p v-if="state.error" class="startup-error" role="alert">{{ state.error }}</p>
  </main>
  <SignInPage v-else-if="showSignIn" :login-url="loginUrl" :connection="state.connection" :error="state.error" @retry="chat.connect()" />
  <div v-else class="shell" @keydown.esc="sidebarOpen && toggleSidebar()">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="Close conversation list" @click="toggleSidebar()"></button>
    <aside class="sidebar" :class="{ open: sidebarOpen }" aria-label="Conversations">
      <div class="sidebar-heading">
        <h2>Chats</h2>
        <button ref="closeMenuButton" class="mobile-close text-button" aria-label="Close conversations" @click="toggleSidebar()">×</button>
        <button class="new-chat text-button" :disabled="actionsDisabled" aria-label="New chat" title="New chat" @click="sidebarOpen = false; following = true; chat.newChat()"><span aria-hidden="true">＋</span></button>
      </div>
      <div class="chat-search">
        <input type="search" aria-label="Search chats" placeholder="Search chats" :value="state.searchQuery" @input="chat.searchConversations(($event.target as HTMLInputElement).value)" @keydown.esc.stop="chat.searchConversations('')" />
        <button v-if="state.searchQuery" class="text-button" aria-label="Clear search" @click="chat.searchConversations('')">×</button>
      </div>
      <nav class="session-list" aria-label="Session history">
        <template v-if="searching">
          <p v-if="state.searchLoading" class="muted" role="status">Searching…</p>
          <div v-else-if="state.searchError" class="list-error" role="alert"><p>{{ state.searchError }}</p><button @click="chat.searchConversations(state.searchQuery)">Try again</button></div>
          <p v-else-if="!visibleSessions.length" class="muted" role="status">No matching chats.</p>
        </template>
        <template v-else>
          <p v-if="state.listLoading && !state.sessions.length" class="muted">Loading conversations…</p>
          <div v-if="state.listError" class="list-error" role="alert"><p>{{ state.listError }}</p><button @click="chat.refreshSessions()">Try again</button></div>
          <p v-else-if="!state.listLoading && !state.sessions.length" class="muted">Your conversations will appear here.</p>
        </template>
        <section v-for="group in sessionGroups" :key="group.label" class="session-group" :aria-label="group.label">
          <h2 class="session-group-heading">{{ group.label }}</h2>
          <button v-for="session in group.sessions" :key="session.id" class="session" :class="{ selected: session.id === state.selected }" :aria-current="session.id === state.selected ? 'page' : undefined" :disabled="['connecting', 'reconnecting', 'expired', 'closed'].includes(state.connection)" @click="selectSession(session)">
            <span class="session-heading">
              <span class="session-title">{{ session.title || 'Untitled conversation' }}</span>
              <span v-if="chat.hasUnreadReply(session)" class="unread-reply" role="img" aria-label="Unread response" title="Unread response"></span>
              <span v-if="chat.sessionStatus(session)" class="session-indicator" :class="{ waiting: chat.sessionStatus(session) === 'waiting' }" :aria-label="chat.sessionStatus(session) === 'waiting' ? 'Waiting for input' : 'Running'" :title="chat.sessionStatus(session) === 'waiting' ? 'Waiting for input' : 'Running'" role="img"></span>
            </span>
          </button>
        </section>
        <button v-if="!searching && state.sessions.length < state.total" class="load-more" :disabled="state.listLoading" @click="chat.refreshSessions(true)">{{ state.listLoading ? 'Loading…' : 'Load more conversations' }}</button>
        <p v-if="searching && state.searchResults.length === 100" class="search-limit">Showing up to 100 matches. Refine your search for more.</p>
      </nav>
      <div v-if="state.authRequired && state.identity" class="sidebar-footer">
        <form method="post" action="/auth/logout" @submit="logout"><button class="text-button">Sign out</button></form>
      </div>
    </aside>

    <main :inert="sidebarOpen">
      <header class="conversation-header">
        <button ref="menuButton" class="mobile-menu" aria-label="Open conversations" :aria-expanded="sidebarOpen" @click="toggleSidebar()">☰</button>
        <div class="conversation-heading"><h1>{{ state.title }}</h1></div>
        <div v-if="state.selected" class="header-actions">
          <button :disabled="actionsDisabled" @click="showDialog('rename')">Rename</button>
          <button :disabled="actionsDisabled || state.running || state.sending" @click="showDialog('delete')">Delete</button>
        </div>
      </header>

      <div v-if="state.error" class="banner warning" role="alert"><span>{{ state.error }}</span><button v-if="state.connection === 'failed'" @click="chat.connect()">Retry connection</button><button v-else class="text-button" aria-label="Dismiss error" @click="state.error = ''">×</button></div>
      <div v-if="state.uncertain" class="banner warning" role="alert"><div>The last send may have reached Hermes. Check the recovered conversation before sending again. Your draft is retained.</div><button :disabled="state.connection !== 'ready'" @click="chat.acknowledgeUncertain()">I’ve checked; keep editing</button></div>

      <div ref="transcript" class="transcript" tabindex="0" aria-label="Conversation messages" @scroll="trackScroll">
        <div class="conversation-width">
          <button v-if="state.hasOlder" class="older-button" :disabled="state.olderLoading || state.connection !== 'ready'" @click="loadOlder">{{ state.olderLoading ? 'Loading…' : '↑ Load older messages' }}</button>
          <div v-if="!state.messages.length && !state.running" class="empty-conversation">
            <span class="empty-mark" aria-hidden="true">a</span>
            <h2>Start a conversation.</h2>
            <p>Send a message to start.</p>
          </div>
          <template v-for="item in displayedItems" :key="item.key">
            <ConversationTurn v-if="item.kind === 'turn'" :turn="item.turn" :thinking="state.running && !state.activity" @image-load="scrollToLatest(false)" />
            <BackgroundTasks v-else :tasks="item.tasks" error="" :connected="true" />
          </template>
          <div v-if="state.activity" class="activity" role="status"><span v-if="state.running" class="pulse" aria-hidden="true"></span>{{ state.activity }}</div>
          <p v-if="state.taskError && !runningTasks.length" class="muted task-status-error" role="status">{{ state.taskError }}</p>
          <RequestCard v-for="request in displayedRequests" :key="request.id" :request="request" :disabled="actionsDisabled" :dashboard-url="state.endpoint || '/'" @answer="chat.answer(request, $event)" />
          <section v-for="approval in displayedApprovals" :key="approval.request_id || 'pending'" class="request-card">
            <h3>Approval required</h3><p>{{ approval.description }}</p><pre v-if="approval.command">{{ approval.command }}</pre>
            <div class="button-row"><button v-for="choice in approvalChoices(approval)" :key="choice" :disabled="actionsDisabled" @click="chat.approve(approval, choice)">{{ approvalLabels[choice] || choice }}</button></div>
          </section>
        </div>
      </div>
      <button v-if="!following" class="jump-latest" @click="scrollToLatest()">↓ Latest messages</button>

      <footer class="composer-footer">
        <div v-if="runningTasks.length" class="pinned-tasks conversation-width">
          <BackgroundTasks :tasks="runningTasks" :error="state.taskError" :connected="state.connection === 'ready'" />
        </div>
        <form class="composer conversation-width" @submit.prevent="send">
          <label class="sr-only" for="prompt">Message Hermes</label>
          <textarea id="prompt" ref="composer" v-model="state.draft" rows="2" placeholder="Message Hermes…" title="Enter to send · Shift + Enter for a new line" :disabled="state.connection === 'expired' || state.connection === 'closed'" @keydown="composerKey"></textarea>
          <div class="composer-bottom">
            <div class="composer-options"><ComposerSettings :state="state" @model="chat.chooseModel($event)" @reasoning="chat.chooseReasoning($event)" @confirm="state.modelConfirmation && chat.chooseModel(state.modelConfirmation, true)" @cancel="state.modelConfirmation = undefined" @retry="chat.refreshSettings()" /></div>
            <button v-if="state.running" type="button" class="stop" :disabled="actionsDisabled" @click="chat.stop()">■ Stop</button>
            <button v-else class="primary send" :disabled="state.runtime ? !chat.canSend() : state.connection !== 'ready' || state.settingsPending || !state.draft.trim()" type="submit">{{ state.sending ? 'Sending…' : 'Send ↑' }}</button>
          </div>
        </form>
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
