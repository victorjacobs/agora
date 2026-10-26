<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ChatClient, initialState } from './hermes/chat'
import NotificationToggle from './NotificationToggle.vue'
import { notificationState, ReplyNotifications } from './reply-notifications'
import { PushNotifications } from './push-notifications'
import ConversationPin from './ConversationPin.vue'
import ConversationIndicators from './ConversationIndicators.vue'
import { conversationKey, usePinnedConversations } from './pinned-conversations'
import { groupSessions } from './session-groups'
import { conversationTimeline } from './hermes/transcript'
import { taskRunning } from './hermes/tasks'
import ImageAttachments from './ImageAttachments.vue'
import SlashCommands from './SlashCommands.vue'
import ComposerSettings from './ComposerSettings.vue'
import ConversationSwitcher from './ConversationSwitcher.vue'
import BackgroundTasks from './BackgroundTasks.vue'
import ChatProcesses from './ChatProcesses.vue'
import ProviderQuota from './ProviderQuota.vue'
import MemoryStateView from './MemoryStateView.vue'
import { memorySections, type MemorySection } from './hermes/memory-state'
import CronView from './CronView.vue'
import ResultsView from './ResultsView.vue'
import type { CronJob } from './hermes/cron'
import MemoryView from './MemoryView.vue'
import CommandApprovalCard from './CommandApprovalCard.vue'
import MemoryApprovalCard from './MemoryApprovalCard.vue'
import { isMemoryApproval, memoryApprovals, type MemoryApproval } from './hermes/memory'
import ConversationTurn from './ConversationTurn.vue'
import RequestCard from './RequestCard.vue'
import SignInPage from './SignInPage.vue'
import type { SessionRow } from './hermes/types'
import { createDrawerGesture, edgeOpeningAllowed } from './conversation-drawer'

const state = reactive(initialState())
const chat = new ChatClient(state)
const notificationSettings = reactive(notificationState())
const notifications = new ReplyNotifications(notificationSettings, () => state.endpoint || window.location.origin, session => {
  if (state.connection === 'ready') selectSession(session)
})
const pushNotifications = new PushNotifications(notificationSettings)
function toggleNotifications() {
  if (notificationSettings.pushEnabled || (!notificationSettings.enabled && notificationSettings.pushConfigured && notificationSettings.pushSupported)) void pushNotifications.toggle()
  else void notifications.toggle()
}
async function signOut() {
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' })
    if (!response.ok && response.type !== 'opaqueredirect' && response.status !== 303) throw new Error()
    chat.dispose(); notifications.clear()
    await pushNotifications.clearDevice()
    window.location.assign('/')
  } catch { notificationSettings.error = 'Could not sign out. Check your connection and try again.' }
}
watch(() => state.connection, value => {
  if (value === 'ready') void pushNotifications.refresh()
  if (value === 'expired') { notifications.clear(); void pushNotifications.clearDevice() }
})
chat.onReply = session => notifications.show(session)
const sidebarOpen = ref(false)
const view = ref<'chat' | 'results' | 'memory' | 'cron' | 'settings'>('chat')
const resultJobs = ref<CronJob[]>([])
const resultJob = ref('')
const requestedCronJob = ref('')
watch(view, value => { if (value !== 'cron') requestedCronJob.value = '' })
function manageResult(id: string) { requestedCronJob.value = id; view.value = 'cron'; sidebarOpen.value = false }
watch(() => state.profile, () => { resultJobs.value = []; resultJob.value = ''; requestedCronJob.value = '' })
const cronView = ref<InstanceType<typeof CronView>>()
const cronJobs = ref<CronJob[]>([])
const memorySection = ref<MemorySection>('pending')
const memoryTitle = computed(() => memorySections.find(section => section.id === memorySection.value)?.title || 'Memory')
const memoryRequests = computed(() => memoryApprovals(state.approvals, state.requests))
const menuButton = ref<HTMLButtonElement>()
const closeMenuButton = ref<HTMLButtonElement>()
const transcript = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const composerPointer = window.matchMedia('(pointer: coarse)')
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
const visibleSessions = computed(() => pins.ordered(chat.visibleSessions(), state.searchQuery).filter(session => session.source !== 'subagent'))
const sessionGroups = computed(() => {
  const pinned = visibleSessions.value.filter(pins.isPinned)
  const groups = groupSessions(visibleSessions.value.filter(session => !pins.isPinned(session)), currentDate.value)
  return pinned.length ? [{ label: 'Pinned', sessions: pinned }, ...groups] : groups
})
const displayedRequests = computed(() => state.requests)
const showingThinking = computed(() => state.running && !state.compressing && !state.activity && !state.messages.some(message => message.tool?.status === 'running'))
const displayedItems = computed(() => conversationTimeline(state.messages, state.tasks, showingThinking.value))
const runningTasks = computed(() => state.tasks.filter(taskRunning))
const activeProcesses = computed(() => state.processes.filter(process => process.status !== 'exited'))
const displayedApprovals = computed(() => state.approvals.filter(approval =>
  !state.requests.some(request => request.method === 'approval' && approval.request_id && request.params.request_id === approval.request_id),
))
const actionsDisabled = computed(() => state.connection !== 'ready' || state.actionPending || state.settingsPending || mutationPending.value)
const loginUrl = computed(() => `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)
const checkingSession = computed(() => !state.identity && ['connecting', 'recovering', 'reconnecting'].includes(state.connection))
const showSignIn = computed(() => !state.identity && state.connection !== 'ready')

const mobileMedia = window.matchMedia('(max-width: 760px)')
const mobile = ref(mobileMedia.matches)
const navigationSheet = ref<HTMLDialogElement>()
const moreSheet = ref<HTMLDialogElement>()
const moreCloseButton = ref<HTMLButtonElement>()
const moreOpen = ref(false)
const secondaryView = computed(() => ['memory', 'cron', 'settings'].includes(view.value))
let moreFocus: HTMLElement | null = null
function closeMore() { moreOpen.value = false; if (moreSheet.value?.open) moreSheet.value.close() }
async function openMore() {
  closeSidebar()
  switcher.value?.close()
  await nextTick()
  moreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  moreOpen.value = true
}
function selectMore(destination: 'memory' | 'cron' | 'settings') { closeMore(); view.value = destination }
watch(moreOpen, async open => {
  if (open && mobile.value) {
    moreSheet.value?.showModal()
    await nextTick()
    moreCloseButton.value?.focus()
  } else {
    if (moreSheet.value?.open) moreSheet.value.close()
    if (moreFocus?.isConnected) moreFocus.focus()
    moreFocus = null
  }
}, { flush: 'post' })
watch(view, () => { closeSidebar(); closeMore() })
const composerFocused = ref(false)
const keyboardVisible = ref(false)
const mobileSelectorTitle = computed(() => {
  if (view.value === 'memory') return memoryTitle.value
  if (view.value === 'results') return resultJobs.value.find(job => job.id === resultJob.value)?.name || resultJob.value || 'All results'
  const job = cronJobs.value.find(job => job.id === cronView.value?.selected)
  return job ? job.name || job.id : 'Choose a job'
})
let navigationFocus: HTMLElement | null = null

const drawerProgress = ref(1)
const drawerDragging = ref(false)
const otherModalOpen = ref(false)
const standalone = window.matchMedia('(display-mode: standalone)')
const edgeSupported = computed(() => edgeOpeningAllowed(navigator.userAgent, navigator.maxTouchPoints, standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)))
const drawerEnabled = computed(() => mobile.value && view.value === 'chat' && !showSignIn.value && !checkingSession.value && !moreOpen.value && !switcherOpen.value && !otherModalOpen.value)
const drawer = createDrawerGesture({
  enabled: () => drawerEnabled.value,
  open: () => sidebarOpen.value,
  width: () => navigationSheet.value?.querySelector<HTMLElement>('#mobile-navigation-content')?.getBoundingClientRect().width || Math.min(window.innerWidth * 0.82, 360),
  move: (progress, dragging) => { drawerProgress.value = progress; drawerDragging.value = dragging },
  reveal: () => { navigationFocus = menuButton.value || null; sidebarOpen.value = true },
  settle: open => { if (open) drawerProgress.value = 1; else closeSidebar() },
})
function startDrawer(event: TouchEvent, opening: boolean) {
  if (opening && !edgeSupported.value) return
  if (document.querySelector('dialog[open]:not(.conversation-drawer)')) return
  if (!opening && (event.target as Element)?.closest('input, textarea, select')) return
  drawer.start(event, opening)
}
watch(drawerEnabled, enabled => { if (!enabled) closeSidebar() })
function closeSidebar() {
  drawer.reset()
  drawerDragging.value = false
  drawerProgress.value = 1
  sidebarOpen.value = false
  if (navigationSheet.value?.open) navigationSheet.value.close()
}
function openSidebar() {
  closeMore()
  navigationFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  sidebarOpen.value = true
}
watch(sidebarOpen, async open => {
  if (open && mobile.value) {
    navigationSheet.value?.showModal()
    await nextTick()
    closeMenuButton.value?.focus()
  } else {
    if (navigationSheet.value?.open) navigationSheet.value.close()
    if (navigationFocus?.isConnected) navigationFocus.focus()
    navigationFocus = null
  }
}, { flush: 'post' })
function changeMobile() { closeSidebar(); closeMore(); mobile.value = mobileMedia.matches }

function openSwitcher() {
  view.value = 'chat'
  if (showSignIn.value || checkingSession.value || dialog.value?.open) return
  if (switcherOpen.value) { switcher.value?.close(); return }
  closeSidebar(); closeMore()
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
  if (state.running ? !chat.canSteer() : !chat.canSend()) return
  const touchKeyboard = composerPointer.matches
  if (touchKeyboard) composer.value?.blur()

  if (state.running) await chat.steer()
  else {
    following.value = true
    await chat.send()
  }
  if (!touchKeyboard) composer.value?.focus()
}

function keepComposerFocus(event: MouseEvent) {
  // iOS can blur despite cancelled pointerdown; mousedown must prevent the pre-click layout shift.
  if (composerPointer.matches && composerFocused.value && keyboardVisible.value && event.button === 0 && !(event.currentTarget as HTMLButtonElement).disabled) event.preventDefault()
}

function composerKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && composerPointer.matches) return
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
  closeSidebar()
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
watch(() => [state.endpoint, state.identity, state.profile], closeSidebar)
watch(() => state.selected, () => { following.value = true })
watch(() => state.tasks.map(task => [task.key, task.status]), () => {
  if (following.value) void scrollToLatest(false)
}, { flush: 'post' })
watch([() => state.draft, composer, mobile], resizeComposer, { flush: 'post' })
watch(showSignIn, value => {
  if (value) { closeSidebar(); closeMore() }
  if (value && switcherOpen.value) {
    switcher.value?.close()
    switcherOpen.value = false
    previousSearch = ''
    chat.searchConversations('')
  }
})
let releaseViewport = () => {}
let modalObserver: MutationObserver | undefined
onMounted(() => {
  modalObserver = new MutationObserver(() => {
    otherModalOpen.value = Boolean(document.querySelector('dialog[open]:not(.navigation-sheet)'))
  })
  modalObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
  const viewport = window.visualViewport
  if (viewport) {
    const style = document.documentElement.style
    let unoccludedHeight = Math.max(window.innerHeight, viewport.height)
    let viewportWidth = window.innerWidth
    const fitViewport = () => {
      // Pinch zoom must pan the existing layout, not shrink/reposition the app.
      if (viewport.scale !== 1) return
      // Keep the pre-keyboard height: WebKit can shrink innerHeight as well.
      if (!composerFocused.value || window.innerWidth !== viewportWidth) {
        unoccludedHeight = Math.max(window.innerHeight, viewport.height)
        viewportWidth = window.innerWidth
      }
      style.setProperty('--app-height', `${viewport.height}px`)
      style.setProperty('--app-top', `${viewport.offsetTop}px`)
      keyboardVisible.value = composerPointer.matches && unoccludedHeight - viewport.height > 120
    }
    fitViewport()
    window.addEventListener('resize', fitViewport)
    viewport.addEventListener('resize', fitViewport)
    viewport.addEventListener('scroll', fitViewport)
    releaseViewport = () => {
      window.removeEventListener('resize', fitViewport)
      viewport.removeEventListener('resize', fitViewport)
      viewport.removeEventListener('scroll', fitViewport)
      style.removeProperty('--app-height')
      style.removeProperty('--app-top')
    }
  }
  void chat.start(new URLSearchParams(window.location.search).get('profile') || import.meta.env.VITE_HERMES_PROFILE)
  dateTimer = setInterval(() => { currentDate.value = new Date() }, 60_000)
  window.addEventListener('resize', resizeComposer)
  window.addEventListener('keydown', globalKey)
  mobileMedia.addEventListener?.('change', changeMobile)
})
onBeforeUnmount(() => { modalObserver?.disconnect(); drawer.dispose(); if (moreSheet.value?.open) moreSheet.value.close(); if (navigationSheet.value?.open) navigationSheet.value.close(); mobileMedia.removeEventListener?.('change', changeMobile); releaseViewport(); clearInterval(dateTimer); window.removeEventListener('resize', resizeComposer); window.removeEventListener('keydown', globalKey); pushNotifications.dispose(); notifications.dispose(); chat.dispose() })
</script>

<template>
  <main v-if="checkingSession" class="startup-page" aria-label="Loading chat">
    <span class="brand-mark" aria-hidden="true">a</span>
    <p role="status"><span class="session-indicator" aria-hidden="true"></span>Loading…</p>
    <p v-if="state.error" class="startup-error" role="alert">{{ state.error }}</p>
  </main>
  <SignInPage v-else-if="showSignIn" :login-url="loginUrl" :connection="state.connection" :error="state.error" @retry="chat.connect()" />
  <div v-else class="shell" :class="{ 'keyboard-open': view === 'chat' && composerFocused && keyboardVisible }">
    <div v-if="drawerEnabled && edgeSupported && (!sidebarOpen || drawerDragging)" class="conversation-edge" aria-hidden="true" @touchstart.passive="startDrawer($event, true)"></div>
    <dialog ref="navigationSheet" class="navigation-sheet" :class="{ 'conversation-drawer': mobile && view === 'chat', 'drawer-dragging': drawerDragging }" :style="mobile && view === 'chat' ? { '--drawer-progress': drawerProgress } : undefined" @touchstart.passive="view === 'chat' && startDrawer($event, false)" :aria-label="view === 'chat' ? 'Choose a chat' : view === 'memory' ? 'Choose a memory section' : view === 'results' ? 'Choose result jobs' : 'Choose a job'" @cancel.prevent="closeSidebar" @close="closeSidebar" @click="($event.target === navigationSheet) && closeSidebar()"><div id="mobile-navigation-content"></div></dialog>
    <dialog ref="moreSheet" class="navigation-sheet more-sheet" aria-label="More" @cancel.prevent="closeMore" @close="closeMore" @click="($event.target === moreSheet) && closeMore()">
      <div class="more-content">
        <div class="more-heading"><h2>More</h2><button ref="moreCloseButton" class="text-button" aria-label="Close More" @click="closeMore">×</button></div>
        <nav aria-label="More views">
          <button aria-label="Memory" @click="selectMore('memory')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5c-3-4-8-1-7 3-4 1-4 7 0 8-1 4 5 6 7 2V5Zm0 0c3-4 8-1 7 3 4 1 4 7 0 8 1 4-5 6-7 2V5ZM5 8l3 2m-3 6 3-2m11-6-3 2m3 6-3-2" /></svg><span><strong>Memory</strong><small>Notes and preferences</small></span><span v-if="memoryRequests.length" class="more-count" :aria-label="`${memoryRequests.length} pending memory updates`">{{ memoryRequests.length }}</span><span class="more-chevron" aria-hidden="true">›</span></button>
          <button aria-label="Jobs" @click="selectMore('cron')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg><span><strong>Jobs</strong><small>Schedules and recent runs</small></span><span class="more-chevron" aria-hidden="true">›</span></button>
          <button aria-label="Settings" @click="selectMore('settings')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg><span><strong>Settings</strong><small>Notifications, usage and account</small></span><span class="more-chevron" aria-hidden="true">›</span></button>
        </nav>
      </div>
    </dialog>
    <nav class="app-rail" aria-label="Application views">
      <button :class="{ active: view === 'chat' }" :aria-current="view === 'chat' ? 'page' : undefined" aria-label="Chat" title="Chat" @click="view = 'chat'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" /></svg><span class="rail-label">Chat</span></button>
      <button :class="{ active: view === 'results' }" :aria-current="view === 'results' ? 'page' : undefined" aria-label="Results" title="Results" @click="view = 'results'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg><span class="rail-label">Results</span></button>
      <button v-if="!mobile" :class="{ active: view === 'memory' }" :aria-current="view === 'memory' ? 'page' : undefined" aria-label="Memory" title="Memory" @click="view = 'memory'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 5c-3-4-8-1-7 3-4 1-4 7 0 8-1 4 5 6 7 2V5Zm0 0c3-4 8-1 7 3 4 1 4 7 0 8 1 4-5 6-7 2V5ZM5 8l3 2m-3 6 3-2m11-6-3 2m3 6-3-2" /></svg><span v-if="memoryRequests.length" class="rail-badge">{{ memoryRequests.length }}</span><span class="rail-label">Memory</span></button>
      <button v-if="!mobile" :class="{ active: view === 'cron' }" :aria-current="view === 'cron' ? 'page' : undefined" :aria-label="mobile ? 'Jobs' : 'Cron jobs'" title="Cron jobs" @click="view = 'cron'; sidebarOpen = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg><span class="rail-label">Jobs</span></button>
      <button v-if="!mobile" class="rail-settings" :class="{ active: view === 'settings' }" :aria-current="view === 'settings' ? 'page' : undefined" aria-label="Settings" title="Settings" @click="view = 'settings'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button v-else :class="{ active: secondaryView || moreOpen }" :aria-current="secondaryView ? 'page' : undefined" aria-label="More" :aria-describedby="memoryRequests.length ? 'pending-memory-count' : undefined" title="More" aria-haspopup="dialog" :aria-expanded="moreOpen" @click="openMore"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="12" r="2"/></svg><span v-if="memoryRequests.length" id="pending-memory-count" class="rail-badge" :aria-label="`${memoryRequests.length} pending memory updates`">{{ memoryRequests.length }}</span><span class="rail-label">More</span></button>
    </nav>
    <Teleport defer to="#mobile-navigation-content" :disabled="!mobile">
    <aside v-show="view !== 'settings'" class="sidebar" :class="{ open: sidebarOpen }" :aria-label="view === 'chat' ? 'Chats' : view === 'memory' ? 'Memory navigation' : view === 'results' ? 'Results navigation' : 'Cron navigation'">
      <div class="sidebar-heading">
        <h2>{{ mobile ? (view === 'chat' ? 'Chats' : view === 'memory' ? 'Choose a section' : view === 'results' ? 'Choose result jobs' : 'Choose a job') : (view === 'chat' ? 'Chats' : view === 'memory' ? 'Memory' : view === 'results' ? 'Results' : 'Cron') }}</h2>
        <button ref="closeMenuButton" class="mobile-close text-button" :aria-label="view === 'chat' ? 'Close chats' : view === 'memory' ? 'Close memory navigation' : view === 'results' ? 'Close results navigation' : 'Close cron navigation'" @click="closeSidebar()">×</button>
        <button v-if="view === 'chat' && !mobile" class="new-chat text-button" :disabled="actionsDisabled" aria-label="New chat" title="New chat" @click="view = 'chat'; sidebarOpen = false; following = true; chat.newChat()"><span aria-hidden="true">{{ mobile ? '+' : '＋' }}</span></button>
        <button v-if="view === 'cron' && !mobile" class="new-chat text-button" :disabled="!cronView?.ready || cronView?.busy" aria-label="New cron job" title="New cron job" @click="cronView?.newJob(); sidebarOpen = false"><span aria-hidden="true">＋</span></button>
      </div>
      <button v-if="mobile && view === 'chat'" class="drawer-new-chat" :disabled="actionsDisabled" @click="closeSidebar(); following = true; chat.newChat()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>New chat</button>
      <div v-if="view === 'chat'" class="chat-search">
        <input type="search" aria-label="Search chats" placeholder="Search chats" :value="state.searchQuery" @input="chat.searchConversations(($event.target as HTMLInputElement).value)" @keydown.esc.stop="chat.searchConversations('')" />
        <button v-if="state.searchQuery" class="text-button" aria-label="Clear search" @click="chat.searchConversations('')">×</button>
        <button v-else class="text-button switcher-shortcut" aria-label="Switch chat" aria-keyshortcuts="Meta+K Control+K" @click="openSwitcher">{{ switcherShortcut }}</button>
      </div>
      <nav v-if="view === 'chat'" class="session-list" aria-label="Session history">
        <template v-if="searching">
          <p v-if="state.searchLoading" class="muted" role="status">Searching…</p>
          <div v-else-if="state.searchError" class="list-error" role="alert"><p>{{ state.searchError }}</p><button @click="chat.searchConversations(state.searchQuery)">Try again</button></div>
          <p v-else-if="!visibleSessions.length" class="muted" role="status">No matching chats.</p>
        </template>
        <template v-else>
          <p v-if="state.listLoading && !state.sessions.length" class="muted">Loading chats…</p>
          <div v-if="state.listError" class="list-error" role="alert"><p>{{ state.listError }}</p><button @click="chat.refreshSessions()">Try again</button></div>
          <p v-else-if="!state.listLoading && !visibleSessions.length" class="muted">Your chats will appear here.</p>
        </template>
        <p v-if="pins.error.value" class="muted" role="alert">{{ pins.error.value }}</p>
        <section v-for="group in sessionGroups" :key="group.label" class="session-group" :aria-label="group.label">
          <h2 class="session-group-heading">{{ group.label }}</h2>
          <div v-for="session in group.sessions" :key="conversationKey(session)" class="session-row"><button class="session" :class="{ selected: conversationKey(session) === conversationKey(currentSession) }" :aria-current="conversationKey(session) === conversationKey(currentSession) ? 'page' : undefined" :disabled="['connecting', 'reconnecting', 'expired', 'closed'].includes(state.connection)" @click="selectSession(session)">
            <span class="session-heading">
              <span class="session-title">{{ session.title || 'Untitled chat' }}</span>
              <ConversationIndicators :status="chat.sessionStatus(session)" :process-count="chat.sessionProcessCount(session)" :unread="chat.hasUnreadReply(session)" />
            </span>
          </button><ConversationPin :pinned="pins.isPinned(session)" :disabled="state.connection !== 'ready'" @toggle="pins.toggle(session)" /></div>
        </section>
        <button v-if="!searching && state.sessions.length < state.total" class="load-more" :disabled="state.listLoading" @click="chat.refreshSessions(true)">{{ state.listLoading ? 'Loading…' : 'Load more chats' }}</button>
        <p v-if="searching && state.searchResults.length === 100" class="search-limit">Showing up to 100 matches. Refine your search for more.</p>
      </nav>
      <nav v-else-if="view === 'memory'" class="session-list" aria-label="Memory sections">
        <button v-for="section in memorySections" :key="section.id" class="session" :class="{ selected: memorySection === section.id }" :aria-current="memorySection === section.id ? 'page' : undefined" @click="memorySection = section.id; sidebarOpen = false"><span class="session-heading"><span class="session-title">{{ section.title }}</span><span v-if="section.id === 'pending' && memoryRequests.length" class="memory-section-count">{{ memoryRequests.length }}</span></span></button>
      </nav>
      <nav v-else-if="view === 'results'" class="session-list" aria-label="Result jobs"><button class="session" :class="{ selected: !resultJob }" :aria-current="!resultJob ? 'page' : undefined" @click="resultJob = ''; sidebarOpen = false"><span class="session-title">All results</span></button><h2 class="session-group-heading">Jobs</h2><button v-for="job in resultJobs" :key="job.id" class="session" :class="{ selected: resultJob === job.id }" :aria-current="resultJob === job.id ? 'page' : undefined" @click="resultJob = job.id; sidebarOpen = false"><span class="session-title">{{ job.name || job.id }}</span></button></nav>
      <nav v-else class="session-list" aria-label="Scheduled jobs"><button v-for="job in cronJobs" :key="job.id" class="session" :class="{ selected: cronView?.selected === job.id }" :aria-current="cronView?.selected === job.id ? 'page' : undefined" :disabled="cronView?.busy" @click="cronView?.select(job.id); sidebarOpen = false"><span class="session-heading"><span class="session-title">{{ job.name || job.id }}</span><svg v-if="job.enabled === false || job.state === 'paused'" class="cron-paused" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" role="img" aria-label="Paused"><path d="M8 5v14M16 5v14" /></svg></span><span v-if="mobile && job.schedule_display" class="job-selector-meta">{{ job.schedule_display }}</span></button></nav>
      <button v-if="mobile && view === 'cron'" class="sheet-new-job" :disabled="!cronView?.ready || cronView?.busy" @click="cronView?.newJob(); sidebarOpen = false"><span aria-hidden="true">+</span> New job</button>
    </aside>
    </Teleport>

    <main :inert="sidebarOpen || moreOpen">
      <header class="conversation-header">
        <button v-if="view === 'chat'" ref="menuButton" class="mobile-menu" aria-label="Open chats" aria-haspopup="dialog" :aria-expanded="sidebarOpen" @click="openSidebar()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5" /></svg></button>
        <button v-if="mobile && secondaryView" class="more-back text-button" @click="openMore"><span aria-hidden="true">‹</span> More</button>
        <div class="conversation-heading"><h1>{{ view === 'settings' ? 'Settings' : view === 'memory' ? (mobile ? 'Memory' : memoryTitle) : view === 'cron' ? (mobile ? 'Jobs' : 'Cron jobs') : view === 'results' ? 'Results' : state.title }}</h1></div>
        <div v-if="state.selected && view === 'chat'" class="header-actions">
          <ConversationPin :pinned="pins.isPinned(currentSession)" :disabled="state.connection !== 'ready'" @toggle="pins.toggle(currentSession)" />
          <button :disabled="actionsDisabled" @click="showDialog('rename')">Rename</button>
          <button :disabled="actionsDisabled || state.running || state.sending" @click="showDialog('delete')">Delete</button>
        </div>
      </header>
      <div v-if="view !== 'chat' && view !== 'settings'" class="mobile-selector-row"><button class="mobile-selector" aria-haspopup="dialog" :aria-expanded="sidebarOpen" :disabled="view === 'cron' && cronView?.busy" @click="openSidebar()"><span>{{ mobileSelectorTitle }}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div>

      <div v-if="state.error" class="banner warning" role="alert"><span>{{ state.error }}</span><button v-if="state.connection === 'failed'" @click="chat.connect()">Retry connection</button><button v-else class="text-button" aria-label="Dismiss error" @click="state.error = ''">×</button></div>
      <div v-if="state.uncertain" class="banner warning" role="alert"><div>The last send may have reached Hermes. Check the recovered chat before sending again. Your draft is retained.</div><button :disabled="state.connection !== 'ready'" @click="chat.acknowledgeUncertain()">I’ve checked; keep editing</button></div>

      <section v-if="view === 'settings'" class="settings-view" aria-label="App settings">
        <div class="settings-content">
          <h2>This device</h2>
          <div class="settings-card"><NotificationToggle :state="notificationSettings" @toggle="toggleNotifications" /></div>
          <h2>Usage</h2>
          <div class="settings-card"><ProviderQuota :providers="state.modelProviders" :current-provider="state.provider" :profile="state.profile" :connected="state.connection === 'ready'" :load="(provider, profile) => chat.providerQuota(provider, profile)" /></div>
          <h2>Account</h2>
          <div class="settings-card account-identity"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/></svg><div><strong>{{ state.identity || 'Hermes connection' }}</strong><p>{{ state.identity ? 'Signed in through Hermes' : state.connection === 'ready' ? 'Connected to Hermes' : 'Reconnecting to Hermes' }}</p></div></div>
          <button v-if="state.identity" class="settings-card settings-signout" @click="signOut"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h10" /></svg> Sign out<span class="more-chevron" aria-hidden="true">›</span></button>
        </div>
      </section>
      <CronView ref="cronView" v-show="view === 'cron'" :active="view === 'cron'" :connected="state.connection === 'ready'" :profile="state.profile" :requested-job="requestedCronJob" @jobs="cronJobs = $event" />
      <ResultsView v-show="view === 'results'" :active="view === 'results'" :connected="state.connection === 'ready'" :profile="state.profile" :job-id="resultJob" @jobs="resultJobs = $event; if (resultJob && !$event.some(job => job.id === resultJob)) resultJob = ''" @manage="manageResult" />
      <MemoryView v-show="view === 'memory' && memorySection === 'pending'" :active="view === 'memory' && memorySection === 'pending'" :runtime="state.runtime" :profile="state.profile" :connected="state.connection === 'ready'" :approvals="memoryRequests" :disabled="actionsDisabled" :load="(runtime, profile) => chat.pendingMemory(runtime, profile)" @decide="decideMemory" />
      <MemoryStateView v-if="memorySection !== 'pending'" v-show="view === 'memory'" :active="view === 'memory'" :section="memorySection" :runtime="state.runtime" :profile="state.profile" :connected="state.connection === 'ready'" :load="(section, profile) => chat.inspectMemory(section, profile)" :read="(id, profile) => chat.readMemoryEntry(id, profile)" :mutate="(id, profile, content) => chat.mutateMemoryEntry(id, profile, content)" />
      <div v-show="view === 'chat'" ref="transcript" class="transcript" tabindex="0" aria-label="Chat messages" @scroll="trackScroll">
        <div class="conversation-width">
          <button v-if="state.hasOlder" class="older-button" :disabled="state.olderLoading || state.connection !== 'ready'" @click="loadOlder">{{ state.olderLoading ? 'Loading…' : '↑ Load older messages' }}</button>
          <div v-if="!state.messages.length && !state.running" class="empty-conversation">
            <h2>What are we getting into?</h2>
            <p>Bring a wild idea, a stubborn bug, or that thing you’ve been putting off.</p>
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
        <div v-if="runningTasks.length || activeProcesses.length || state.processError" class="pinned-work conversation-width">
          <div v-if="runningTasks.length" class="pinned-tasks">
            <BackgroundTasks :tasks="runningTasks" :error="state.taskError" :connected="state.connection === 'ready'" />
          </div>
          <ChatProcesses v-if="activeProcesses.length" :key="JSON.stringify([state.profile, state.selected])" :processes="activeProcesses" :connected="state.connection === 'ready'" :error="state.processError" :stopping="state.processStops" :scope="JSON.stringify([state.profile, state.selected])" @stop="chat.stopProcess($event)" @retry="chat.refreshProcesses()" />
          <p v-else-if="state.processError" class="process-status-error" role="status">{{ state.processError }} <button :disabled="state.connection !== 'ready'" @click="chat.refreshProcesses()">Retry status</button></p>
        </div>
        <form class="composer conversation-width" style="position: relative" @submit.prevent="send" @paste="attachments?.paste($event)" @dragover.prevent @drop="attachments?.drop($event)">
          <ImageAttachments ref="attachments" :images="state.images" :scope="JSON.stringify([state.selected, state.profile])" :disabled="state.sending || state.readingImages || state.running || state.compressing || state.connection !== 'ready'" @add="state.images.push($event)" @remove="state.images = state.images.filter(image => image.id !== $event)" @error="state.error = $event" @busy="state.readingImages = $event" />
          <SlashCommands ref="slashPicker" :draft="state.draft" :scope="JSON.stringify([state.runtime, state.profile])" :connected="state.connection === 'ready'" :load="() => chat.commands()" @select="state.draft = $event; composer?.focus()" />
          <label class="sr-only" for="prompt">Message Hermes</label>
          <textarea id="prompt" ref="composer" v-model="state.draft" @focus="composerFocused = true" @blur="composerFocused = false" :role="slashPicker?.visible ? 'combobox' : undefined" :aria-expanded="slashPicker?.visible ? true : undefined" :aria-controls="slashPicker?.visible ? 'slash-options' : undefined" :aria-activedescendant="slashPicker?.activeId" :aria-autocomplete="slashPicker?.visible ? 'list' : undefined" :rows="mobile ? 1 : 2" enterkeyhint="enter" placeholder="Message Hermes…" :title="composerPointer.matches ? 'Enter for a new line' : state.running ? 'Enter to steer · Shift + Enter for a new line' : 'Enter to send · Shift + Enter for a new line'" :disabled="state.connection === 'expired' || state.connection === 'closed'" @keydown="composerKey"></textarea>
          <div class="composer-bottom">
            <div class="composer-options"><ComposerSettings :state="state" @model="chat.chooseModel($event)" @reasoning="chat.chooseReasoning($event)" @confirm="state.modelConfirmation && chat.chooseModel(state.modelConfirmation, true)" @cancel="state.modelConfirmation = undefined" @retry="chat.refreshSettings()" /></div>
            <button v-if="state.running" type="button" class="stop" :disabled="actionsDisabled" @click="chat.stop()">■ Stop</button>
            <button v-if="state.running" class="primary send" @mousedown="keepComposerFocus" :disabled="!chat.canSteer()" type="submit" title="Send guidance to the running turn without interrupting it">{{ state.sending ? 'Steering…' : 'Steer ↑' }}</button>
            <button v-else class="primary send" @mousedown="keepComposerFocus" :disabled="state.runtime ? !chat.canSend() : state.connection !== 'ready' || state.settingsPending || state.readingImages || (!state.draft.trim() && !state.images.length)" type="submit">{{ state.sending ? 'Sending…' : 'Send ↑' }}</button>
          </div>
        </form>
      </footer>
    </main>

    <ConversationSwitcher ref="switcher" :sessions="visibleSessions" :session-status="session => chat.sessionStatus(session)" :process-count="session => chat.sessionProcessCount(session)" :has-unread="session => chat.hasUnreadReply(session)" :is-pinned="pins.isPinned" :query="state.searchQuery" :loading="searching ? state.searchLoading : state.listLoading" :error="state.searchError || state.listError" :selected="state.selected" :limited="searching && state.searchResults.length >= 100" :has-more="state.sessions.length < state.total" :more-loading="state.listLoading" @search="chat.searchConversations($event)" @select="selectSession" @close="closeSwitcher" @retry="searching ? chat.searchConversations(state.searchQuery) : chat.refreshSessions()" @more="chat.refreshSessions(true)" />
    <dialog ref="dialog" @cancel="mutationPending && $event.preventDefault()">
      <form @submit.prevent="mutate">
        <h2>{{ dialogKind === 'rename' ? 'Rename chat' : 'Delete chat?' }}</h2>
        <label v-if="dialogKind === 'rename'">Title<input v-model="newTitle" autofocus required :disabled="mutationPending" /></label>
        <p v-else>“{{ state.title }}” will be deleted from Hermes. This cannot be undone.</p>
        <div class="button-row"><button type="button" :disabled="mutationPending" @click="dialog?.close()">Cancel</button><button :class="dialogKind === 'delete' ? 'danger' : 'primary'" :disabled="mutationPending" type="submit">{{ mutationPending ? 'Saving…' : dialogKind === 'rename' ? 'Save title' : 'Delete chat' }}</button></div>
      </form>
    </dialog>
  </div>
</template>
