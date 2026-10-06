<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ChatClient, initialState } from './hermes/chat'
import NotificationToggle from './NotificationToggle.vue'
import { notificationState, ReplyNotifications } from './reply-notifications'
import ConversationPin from './ConversationPin.vue'
import { conversationKey, usePinnedConversations } from './pinned-conversations'
import { groupSessions } from './session-groups'
import { conversationTimeline } from './hermes/transcript'
import { taskRunning } from './hermes/tasks'
import ImageAttachments from './ImageAttachments.vue'
import SlashCommands from './SlashCommands.vue'
import ComposerSettings from './ComposerSettings.vue'
import ConversationSwitcher from './ConversationSwitcher.vue'
import BackgroundTasks from './BackgroundTasks.vue'
import ProviderQuota from './ProviderQuota.vue'
import MemoryStateView from './MemoryStateView.vue'
import { memorySections, type MemorySection } from './hermes/memory-state'
import CronView from './CronView.vue'
import type { CronJob } from './hermes/cron'
import MemoryView from './MemoryView.vue'
import CommandApprovalCard from './CommandApprovalCard.vue'
import MemoryApprovalCard from './MemoryApprovalCard.vue'
import { isMemoryApproval, memoryApprovals, type MemoryApproval } from './hermes/memory'
import ConversationTurn from './ConversationTurn.vue'
import RequestCard from './RequestCard.vue'
import SignInPage from './SignInPage.vue'
import type { SessionRow } from './hermes/types'

const state = reactive(initialState())
const chat = new ChatClient(state)
const notificationSettings = reactive(notificationState())
const notifications = new ReplyNotifications(notificationSettings, () => state.endpoint || window.location.origin, session => {
  if (state.connection === 'ready') selectSession(session)
})
chat.onReply = session => notifications.show(session)
const sidebarOpen = ref(false)
const view = ref<'chat' | 'memory' | 'cron'>('chat')
const cronView = ref<InstanceType<typeof CronView>>()
const cronJobs = ref<CronJob[]>([])
const memorySection = ref<MemorySection>('pending')
const memoryTitle = computed(() => memorySections.find(section => section.id === memorySection.value)?.title || 'Memory')
const memoryRequests = computed(() => memoryApprovals(state.approvals, state.requests))
const menuButton = ref<HTMLButtonElement>()
const closeMenuButton = ref<HTMLButtonElement>()
const transcript = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const slashPicker = ref<InstanceType<typeof SlashCommands>>()
const following = ref(true)
const dialog = ref<HTMLDialogElement>()
const switcher = ref<InstanceType<typeof ConversationSwitcher>>()
const switcherOpen = ref(false)
const switcherShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
let previousSearch = ''
const dialogKind = ref<'rename' | 'delete'>('rename')
const newTitle = ref('')
const mutationPending = ref(false)
const currentDate = ref(new Date())
let dateTimer: ReturnType<typeof setInterval> | undefined
const searching = computed(() => Boolean(state.searchQuery.trim()))
const pins = usePinnedConversations(computed(() => state.endpoint || window.location.origin), computed(() => state.connection === 'ready'), computed(() => state.sessions))
const currentSession = computed(() => ({ id: state.selected, profile: state.profile || import.meta.env.VITE_HERMES_PROFILE || 'default' }))
const visibleSessions = computed(() => pins.ordered(chat.visibleSessions(), state.searchQuery))
const sessionGroups = computed(() => {
  const pinned = visibleSessions.value.filter(pins.isPinned)
  const groups = groupSessions(visibleSessions.value.filter(session => !pins.isPinned(session)), currentDate.value)
  return pinned.length ? [{ label: 'Pinned', sessions: pinned }, ...groups] : groups
})
const displayedRequests = computed(() => state.requests)
const showingThinking = computed(() => state.running && !state.compressing && !state.activity && !state.messages.some(message => message.tool?.status === 'running'))
const displayedItems = computed(() => conversationTimeline(state.messages, state.tasks, showingThinking.value))
const runningTasks = computed(() => state.tasks.filter(taskRunning))
const displayedApprovals = computed(() => state.approvals.filter(approval =>
  !state.requests.some(request => request.method === 'approval' && approval.request_id && request.params.request_id === approval.request_id),
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

function openSwitcher() {
  view.value = 'chat'
  if (showSignIn.value || checkingSession.value || dialog.value?.open) return
  if (switcherOpen.value) { switcher.value?.close(); return }
  previousSearch = state.searchQuery
  chat.searchConversations('')
  switcherOpen.value = true
  void switcher.value?.open()
}

function closeSwitcher() {
  switcherOpen.value = false
  chat.searchConversations(previousSearch)
}

function globalKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing && !showSignIn.value && !checkingSession.value) {
    event.preventDefault()
    if (!event.repeat) openSwitcher()
  }
}

function selectSession(session: SessionRow) {
  view.value = 'chat'
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

const attachments = ref<InstanceType<typeof ImageAttachments>>()
async function send() {
  if (!state.runtime && state.connection === 'ready' && (state.draft.trim() || state.images.length)) {
    const images = state.images
    const draft = state.draft
    await chat.newChat()
    state.draft = draft
    state.images = images
  }
  if (!chat.canSend()) return
  following.value = true
  await chat.send()
  composer.value?.focus()
}

function composerKey(event: KeyboardEvent) {
  if (slashPicker.value?.keydown(event)) return
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
  else {
    const deleted = { ...currentSession.value }
    const endpoint = state.endpoint
    await chat.deleteSelected()
    if (state.endpoint === endpoint && state.selected !== deleted.id) pins.remove(deleted)
  }
  mutationPending.value = false
  dialog.value?.close()
}

function decideMemory(approval: MemoryApproval, choice: string) {
  if (approval.request) void chat.answer(approval.request, { choice })
  else void chat.approve(approval, choice)
}

watch(() => [state.messages.length, state.messages.at(-1)?.text, state.messages.at(-1)?.reasoning?.text], () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch(() => [state.requests.length, state.approvals.length, state.compressing], () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch(() => [state.endpoint, state.identity], () => notifications.clear())
watch(() => state.selected, () => { following.value = true })
watch(() => state.tasks.map(task => [task.key, task.status]), () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch([() => state.draft, composer], resizeComposer, { flush: 'post' })
watch(showSignIn, value => {
  if (value && switcherOpen.value) {
    switcher.value?.close()
    switcherOpen.value = false
    previousSearch = ''
    chat.searchConversations('')
  }
})
onMounted(() => {
  void chat.start(import.meta.env.VITE_HERMES_PROFILE)
  dateTimer = setInterval(() => { currentDate.value = new Date() }, 60_000)
  window.addEventListener('resize', resizeComposer)
  window.addEventListener('keydown', globalKey)
})
onBeforeUnmount(() => { clearInterval(dateTimer); window.removeEventListener('resize', resizeComposer); window.removeEventListener('keydown', globalKey); notifications.dispose(); chat.dispose() })
</script>

<template>
  <main v-if="checkingSession" class="startup-page" aria-label="Loading chat">
    <span class="brand-mark" aria-hidden="true">a</span>
    <p role="status"><span class="session-indicator" aria-hidden="true"></span>Loading…</p>
    <p v-if="state.error" class="startup-error" role="alert">{{ state.error }}</p>
  </main>
  <SignInPage v-else-if="showSignIn" :login-url="loginUrl" :connection="state.connection" :error="state.error" @retry="chat.connect()" />
  <div v-else class="shell" @keydown.esc="sidebarOpen && toggleSidebar()">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="Close navigation" @click="toggleSidebar()"></button>
    <nav class="app-rail" aria-label="Application views">
      <button :class="{ active: view === 'chat' }" :aria-current="view === 'chat' ? 'page' : undefined" aria-label="Chat" title="Chat" @click="view = 'chat'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" /></svg></button>
      <button :class="{ active: view === 'memory' }" :aria-current="view === 'memory' ? 'page' : undefined" aria-label="Memory" title="Memory" @click="view = 'memory'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5c-3-4-8-1-7 3-4 1-4 7 0 8-1 4 5 6 7 2V5Zm0 0c3-4 8-1 7 3 4 1 4 7 0 8 1 4-5 6-7 2V5ZM5 8l3 2m-3 6 3-2m11-6-3 2m3 6-3-2" /></svg><span v-if="memoryRequests.length" class="rail-badge">{{ memoryRequests.length }}</span></button>
      <button :class="{ active: view === 'cron' }" :aria-current="view === 'cron' ? 'page' : undefined" aria-label="Cron jobs" title="Cron jobs" @click="view = 'cron'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg></button>
    </nav>
    <aside class="sidebar" :class="{ open: sidebarOpen }" :aria-label="view === 'chat' ? 'Conversations' : view === 'memory' ? 'Memory navigation' : 'Cron navigation'">
      <div class="sidebar-heading">
        <h2>{{ view === 'chat' ? 'Chats' : view === 'memory' ? 'Memory' : 'Cron' }}</h2>
        <button ref="closeMenuButton" class="mobile-close text-button" :aria-label="view === 'chat' ? 'Close conversations' : view === 'memory' ? 'Close memory navigation' : 'Close cron navigation'" @click="toggleSidebar()">×</button>
        <button v-if="view === 'chat'" class="new-chat text-button" :disabled="actionsDisabled" aria-label="New chat" title="New chat" @click="view = 'chat'; sidebarOpen = false; following = true; chat.newChat()"><span aria-hidden="true">＋</span></button>
        <button v-if="view === 'cron'" class="new-chat text-button" :disabled="!cronView?.ready || cronView?.busy" aria-label="New cron job" title="New cron job" @click="cronView?.newJob(); sidebarOpen = false"><span aria-hidden="true">＋</span></button>
      </div>
      <div v-if="view === 'chat'" class="chat-search">
        <input type="search" aria-label="Search chats" placeholder="Search chats" :value="state.searchQuery" @input="chat.searchConversations(($event.target as HTMLInputElement).value)" @keydown.esc.stop="chat.searchConversations('')" />
        <button v-if="state.searchQuery" class="text-button" aria-label="Clear search" @click="chat.searchConversations('')">×</button>
        <button v-else class="text-button switcher-shortcut" aria-label="Switch conversation" aria-keyshortcuts="Meta+K Control+K" @click="openSwitcher">{{ switcherShortcut }}</button>
      </div>
      <nav v-if="view === 'chat'" class="session-list" aria-label="Session history">
        <template v-if="searching">
          <p v-if="state.searchLoading" class="muted" role="status">Searching…</p>
          <div v-else-if="state.searchError" class="list-error" role="alert"><p>{{ state.searchError }}</p><button @click="chat.searchConversations(state.searchQuery)">Try again</button></div>
          <p v-else-if="!visibleSessions.length" class="muted" role="status">No matching chats.</p>
        </template>
        <template v-else>
          <p v-if="state.listLoading && !state.sessions.length" class="muted">Loading conversations…</p>
          <div v-if="state.listError" class="list-error" role="alert"><p>{{ state.listError }}</p><button @click="chat.refreshSessions()">Try again</button></div>
          <p v-else-if="!state.listLoading && !visibleSessions.length" class="muted">Your conversations will appear here.</p>
        </template>
        <p v-if="pins.error.value" class="muted" role="alert">{{ pins.error.value }}</p>
        <section v-for="group in sessionGroups" :key="group.label" class="session-group" :aria-label="group.label">
          <h2 class="session-group-heading">{{ group.label }}</h2>
          <div v-for="session in group.sessions" :key="conversationKey(session)" class="session-row"><button class="session" :class="{ selected: conversationKey(session) === conversationKey(currentSession) }" :aria-current="conversationKey(session) === conversationKey(currentSession) ? 'page' : undefined" :disabled="['connecting', 'reconnecting', 'expired', 'closed'].includes(state.connection)" @click="selectSession(session)">
            <span class="session-heading">
              <span class="session-title">{{ session.title || 'Untitled conversation' }}</span>
              <span v-if="chat.hasUnreadReply(session)" class="unread-reply" role="img" aria-label="Unread response" title="Unread response"></span>
              <span v-if="chat.sessionStatus(session)" class="session-indicator" :class="{ waiting: chat.sessionStatus(session) === 'waiting' }" :aria-label="chat.sessionStatus(session) === 'waiting' ? 'Waiting for input' : 'Running'" :title="chat.sessionStatus(session) === 'waiting' ? 'Waiting for input' : 'Running'" role="img"></span>
            </span>
          </button><ConversationPin :pinned="pins.isPinned(session)" :disabled="state.connection !== 'ready'" @toggle="pins.toggle(session)" /></div>
        </section>
        <button v-if="!searching && state.sessions.length < state.total" class="load-more" :disabled="state.listLoading" @click="chat.refreshSessions(true)">{{ state.listLoading ? 'Loading…' : 'Load more conversations' }}</button>
        <p v-if="searching && state.searchResults.length === 100" class="search-limit">Showing up to 100 matches. Refine your search for more.</p>
      </nav>
      <nav v-else-if="view === 'memory'" class="session-list" aria-label="Memory sections">
        <button v-for="section in memorySections" :key="section.id" class="session" :class="{ selected: memorySection === section.id }" :aria-current="memorySection === section.id ? 'page' : undefined" @click="memorySection = section.id; sidebarOpen = false"><span class="session-heading"><span class="session-title">{{ section.title }}</span><span v-if="section.id === 'pending' && memoryRequests.length" class="memory-section-count">{{ memoryRequests.length }}</span></span></button>
      </nav>
      <nav v-else class="session-list" aria-label="Scheduled jobs"><button v-for="job in cronJobs" :key="job.id" class="session" :class="{ selected: cronView?.selected === job.id }" :disabled="cronView?.busy" @click="cronView?.select(job.id); sidebarOpen = false"><span class="session-heading"><span class="session-title">{{ job.name || job.id }}</span><svg v-if="job.enabled === false || job.state === 'paused'" class="cron-paused" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" role="img" aria-label="Paused"><path d="M8 5v14M16 5v14" /></svg></span></button></nav>
      <div v-show="view === 'chat'" class="sidebar-footer">
        <NotificationToggle :state="notificationSettings" @toggle="notifications.toggle()" />
        <ProviderQuota :providers="state.modelProviders" :current-provider="state.provider" :profile="state.profile" :connected="state.connection === 'ready'" :load="(provider, profile) => chat.providerQuota(provider, profile)" />
      </div>
    </aside>

    <main :inert="sidebarOpen">
      <header class="conversation-header">
        <button ref="menuButton" class="mobile-menu" :aria-label="view === 'chat' ? 'Open conversations' : view === 'memory' ? 'Open memory navigation' : 'Open cron navigation'" :aria-expanded="sidebarOpen" @click="toggleSidebar()">☰</button>
        <div class="conversation-heading"><h1>{{ view === 'memory' ? memoryTitle : view === 'cron' ? 'Cron jobs' : state.title }}</h1></div>
        <div v-if="state.selected && view === 'chat'" class="header-actions">
          <ConversationPin :pinned="pins.isPinned(currentSession)" :disabled="state.connection !== 'ready'" @toggle="pins.toggle(currentSession)" />
          <button :disabled="actionsDisabled" @click="showDialog('rename')">Rename</button>
          <button :disabled="actionsDisabled || state.running || state.sending" @click="showDialog('delete')">Delete</button>
        </div>
      </header>

      <div v-if="state.error" class="banner warning" role="alert"><span>{{ state.error }}</span><button v-if="state.connection === 'failed'" @click="chat.connect()">Retry connection</button><button v-else class="text-button" aria-label="Dismiss error" @click="state.error = ''">×</button></div>
      <div v-if="state.uncertain" class="banner warning" role="alert"><div>The last send may have reached Hermes. Check the recovered conversation before sending again. Your draft is retained.</div><button :disabled="state.connection !== 'ready'" @click="chat.acknowledgeUncertain()">I’ve checked; keep editing</button></div>

      <CronView ref="cronView" v-show="view === 'cron'" :active="view === 'cron'" :connected="state.connection === 'ready'" :profile="state.profile" @jobs="cronJobs = $event" />
      <MemoryView v-show="view === 'memory' && memorySection === 'pending'" :active="view === 'memory' && memorySection === 'pending'" :runtime="state.runtime" :profile="state.profile" :connected="state.connection === 'ready'" :approvals="memoryRequests" :disabled="actionsDisabled" :load="(runtime, profile) => chat.pendingMemory(runtime, profile)" @decide="decideMemory" />
      <MemoryStateView v-if="memorySection !== 'pending'" v-show="view === 'memory'" :active="view === 'memory'" :section="memorySection" :runtime="state.runtime" :profile="state.profile" :connected="state.connection === 'ready'" :load="(section, profile) => chat.inspectMemory(section, profile)" :read="(id, profile) => chat.readMemoryEntry(id, profile)" :mutate="(id, profile, content) => chat.mutateMemoryEntry(id, profile, content)" />
      <div v-show="view === 'chat'" ref="transcript" class="transcript" tabindex="0" aria-label="Conversation messages" @scroll="trackScroll">
        <div class="conversation-width">
          <button v-if="state.hasOlder" class="older-button" :disabled="state.olderLoading || state.connection !== 'ready'" @click="loadOlder">{{ state.olderLoading ? 'Loading…' : '↑ Load older messages' }}</button>
          <div v-if="!state.messages.length && !state.running" class="empty-conversation">
            <h2>Start a conversation.</h2>
            <p>Send a message to start.</p>
          </div>
          <template v-for="item in displayedItems" :key="item.key">
            <ConversationTurn v-if="item.kind === 'turn'" :turn="item.turn" :profile="state.profile" :thinking="showingThinking" @image-load="scrollToLatest(false)" />
            <BackgroundTasks v-else :tasks="item.tasks" error="" :connected="true" />
          </template>
          <div v-if="!state.compressing && (state.activity || state.running || displayedRequests.length || displayedApprovals.length)" class="activity" role="status"><span v-if="state.running" class="pulse" aria-hidden="true"></span>{{ displayedRequests.length || displayedApprovals.length ? 'Waiting for your approval or input' : state.activity || 'Working…' }}</div>
          <p v-if="state.taskError && !runningTasks.length" class="muted task-status-error" role="status">{{ state.taskError }}</p>
          <RequestCard v-for="request in displayedRequests" :key="request.id" :request="request" :disabled="actionsDisabled" :dashboard-url="state.endpoint || '/'" @answer="chat.answer(request, $event)" />
          <template v-for="approval in displayedApprovals" :key="approval.request_id || 'pending'">
          <MemoryApprovalCard v-if="isMemoryApproval(approval)" :approval="approval" :disabled="actionsDisabled" @decide="chat.approve(approval, $event)" />
          <CommandApprovalCard v-else :approval="approval" :disabled="actionsDisabled" @decide="chat.approve(approval, $event)" />
          </template>
        </div>
      </div>
      <button v-if="!following && view === 'chat'" class="jump-latest" @click="scrollToLatest()">↓ Latest messages</button>

      <footer v-show="view === 'chat'" class="composer-footer">
        <div v-if="state.compressing" class="compression-status conversation-width" role="status" :title="state.compressionDetail"><span class="session-indicator" aria-hidden="true"></span><span>Compressing context…</span></div>
        <div v-if="runningTasks.length" class="pinned-tasks conversation-width">
          <BackgroundTasks :tasks="runningTasks" :error="state.taskError" :connected="state.connection === 'ready'" />
        </div>
        <form class="composer conversation-width" style="position: relative" @submit.prevent="send" @paste="attachments?.paste($event)" @dragover.prevent @drop="attachments?.drop($event)">
          <ImageAttachments ref="attachments" :images="state.images" :scope="JSON.stringify([state.selected, state.profile])" :disabled="state.sending || state.readingImages || state.running || state.compressing || state.connection !== 'ready'" @add="state.images.push($event)" @remove="state.images = state.images.filter(image => image.id !== $event)" @error="state.error = $event" @busy="state.readingImages = $event" />
          <SlashCommands ref="slashPicker" :draft="state.draft" :scope="JSON.stringify([state.runtime, state.profile])" :connected="state.connection === 'ready'" :load="() => chat.commands()" @select="state.draft = $event; composer?.focus()" />
          <label class="sr-only" for="prompt">Message Hermes</label>
          <textarea id="prompt" ref="composer" v-model="state.draft" :role="slashPicker?.visible ? 'combobox' : undefined" :aria-expanded="slashPicker?.visible ? true : undefined" :aria-controls="slashPicker?.visible ? 'slash-options' : undefined" :aria-activedescendant="slashPicker?.activeId" :aria-autocomplete="slashPicker?.visible ? 'list' : undefined" rows="2" placeholder="Message Hermes…" title="Enter to send · Shift + Enter for a new line" :disabled="state.connection === 'expired' || state.connection === 'closed'" @keydown="composerKey"></textarea>
          <div class="composer-bottom">
            <div class="composer-options"><ComposerSettings :state="state" @model="chat.chooseModel($event)" @reasoning="chat.chooseReasoning($event)" @confirm="state.modelConfirmation && chat.chooseModel(state.modelConfirmation, true)" @cancel="state.modelConfirmation = undefined" @retry="chat.refreshSettings()" /></div>
            <button v-if="state.running" type="button" class="stop" :disabled="actionsDisabled" @click="chat.stop()">■ Stop</button>
            <button v-else class="primary send" :disabled="state.runtime ? !chat.canSend() : state.connection !== 'ready' || state.settingsPending || state.readingImages || (!state.draft.trim() && !state.images.length)" type="submit">{{ state.sending ? 'Sending…' : 'Send ↑' }}</button>
          </div>
        </form>
      </footer>
    </main>

    <ConversationSwitcher ref="switcher" :sessions="visibleSessions" :query="state.searchQuery" :loading="searching ? state.searchLoading : state.listLoading" :error="state.searchError || state.listError" :selected="state.selected" :limited="searching && state.searchResults.length >= 100" :has-more="state.sessions.length < state.total" :more-loading="state.listLoading" @search="chat.searchConversations($event)" @select="selectSession" @close="closeSwitcher" @retry="searching ? chat.searchConversations(state.searchQuery) : chat.refreshSessions()" @more="chat.refreshSessions(true)" />
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
