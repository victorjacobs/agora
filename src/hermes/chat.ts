import { modelSwitchValue, reasoningEfforts, type ModelChoice, type ModelChangeResult, type ModelInventory, type ModelProvider, type SessionModelInfo } from './settings'
import { anchorFinishedTasks, reconcileTasks, taskEvent, taskRunning, type BackgroundTask, type SubagentRoster } from './tasks'
import { HermesApi, HttpError } from './api'
import { ConnectionLost, Gateway } from './gateway'
import { historyMessages, mergeHistory, restoreInflight } from './transcript'
import type { ActiveSession, Approval, Connection, GatewayEvent, HistoryPage, Message, ServerRequest, SessionRow, Snapshot } from './types'

export function initialState() {
  return {
    connection: 'connecting' as Connection,
    authRequired: false,
    localMode: false,
    endpoint: '',
    identity: '',
    error: '',
    listError: '',
    searchQuery: '',
    searchResults: [] as SessionRow[],
    searchLoading: false,
    searchError: '',
    sessions: [] as SessionRow[],
    activeSessions: [] as Array<ActiveSession & { profile?: string }>,
    unreadReplies: [] as Array<{ id: string; profile?: string }>,
    tasks: [] as BackgroundTask[],
    taskError: '',
    total: 0,
    listLoading: false,
    selected: '',
    runtime: '',
    profile: undefined as string | undefined,
    model: '',
    provider: '',
    reasoning: '',
    reasoningWire: '',
    modelProviders: [] as ModelProvider[],
    settingsLoading: false,
    settingsPending: false,
    settingsError: '',
    settingsNotice: '',
    modelConfirmation: undefined as (ModelChoice & { message: string }) | undefined,
    title: 'New conversation',
    messages: [] as Message[],
    historyOffset: 0,
    hasOlder: false,
    olderLoading: false,
    draft: '',
    running: false,
    sending: false,
    actionPending: false,
    uncertain: false,
    activity: '',
    approvals: [] as Approval[],
    requests: [] as ServerRequest[],
  }
}

export type ChatState = ReturnType<typeof initialState>

export interface ChatLocation {
  origin: string
  selected(): string
  select(id: string): void
}

export class ChatClient {
  private settingsMutation = false
  private settingsRevision = 0
  private settingsReadGeneration = 0
  private selectionGeneration = 0
  private connectionGeneration = 0
  private searchTimer?: ReturnType<typeof setTimeout>
  private searchGeneration = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private activeTimer?: ReturnType<typeof setInterval>
  private activeRequestGeneration?: number
  private activeRevision = 0
  private runtimeSessions = new Map<string, { id: string; profile?: string }>()
  private replySequences = new Map<string, number>()
  private taskRevision = 0
  private taskRequest?: object
  private taskCache = new Map<string, BackgroundTask[]>()
  private attempts = 0
  private stopped = false
  private recovering = false
  private buffered: GatewayEvent[] = []
  private bufferedRequests: ServerRequest[] = []
  private sequence = new Map<string, number>()
  private drafts = new Map<string, string>()
  private uncertain = new Set<string>()
  private configuredProfile?: string

  constructor(
    public state: ChatState,
    private api = new HermesApi(),
    private gateway = new Gateway(),
    private location: ChatLocation = {
      origin: window.location.origin,
      selected: () => new URLSearchParams(window.location.search).get('session') || '',
      select: id => {
        const url = new URL(window.location.href)
        if (id) url.searchParams.set('session', id)
        else url.searchParams.delete('session')
        window.history.replaceState(null, '', url.pathname + url.search)
      },
    },
  ) {
    this.gateway.onEvent = event => this.receiveEvent(event)
    this.gateway.onRequest = request => {
      if (this.recovering) this.bufferedRequests.push(request)
      else if (this.matchesRequest(request)) this.addRequest(request)
    }
    this.gateway.onDisconnect = code => {
      if (this.stopped) return
      clearInterval(this.activeTimer)
      this.connectionGeneration++
      this.selectionGeneration++
      this.recovering = false
      if (code === 1008 || code === 4401) {
        void this.checkRejectedSocket()
      } else if (code === 1002) {
        this.state.connection = 'failed'
        this.state.error = 'Hermes sent an incompatible gateway frame. Check the supported revision.'
      } else this.scheduleReconnect()
    }
  }

  async start(profile?: string) {
    this.configuredProfile = profile || undefined
    this.state.profile = this.configuredProfile
    this.state.selected = this.location.selected()
    try {
      const configuration = await this.api.request<{ mode?: string; endpoint?: string }>('/api/agora/connection')
      this.state.localMode = configuration.mode === 'local'
      this.state.endpoint = configuration.endpoint || ''
    } catch { /* Same-origin Hermes installations do not have a local connection service. */ }
    if (!this.stopped) await this.connect()
  }

  dispose() {
    this.stopped = true
    this.connectionGeneration++
    this.selectionGeneration++
    clearTimeout(this.retryTimer)
    clearTimeout(this.searchTimer)
    this.searchGeneration++
    clearInterval(this.activeTimer)
    this.gateway.close()
  }

  async connect() {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    clearInterval(this.activeTimer)
    const connectionGeneration = ++this.connectionGeneration
    this.selectionGeneration++
    this.recovering = false
    this.state.connection = this.attempts ? 'reconnecting' : 'connecting'
    this.state.error = ''

    try {
      const status = await this.api.request<{ auth_required: boolean }>('/api/status')
      if (connectionGeneration !== this.connectionGeneration) return
      this.state.authRequired = status.auth_required
      let ticket: string | undefined
      if (status.auth_required) {
        const identity = await this.api.request<{ display_name?: string; email?: string }>('/api/auth/me')
        this.state.identity = identity.display_name || identity.email || 'Signed in'
        if (!this.state.localMode) ticket = (await this.api.request<{ ticket: string }>('/api/auth/ws-ticket', { method: 'POST' })).ticket
      } else this.state.identity = 'Hermes dashboard'
      if (connectionGeneration !== this.connectionGeneration) return

      const url = new URL('/api/ws', this.location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      await this.gateway.connect(url.href, ticket)
      if (connectionGeneration !== this.connectionGeneration) return
      await this.gateway.request('client.capabilities', { server_requests: true })
      this.sequence.clear()
      this.replySequences.clear()
      this.state.connection = 'recovering'
      await this.refreshSessions()
      if (connectionGeneration !== this.connectionGeneration) return
      if (this.state.selected) await this.open(this.state.selected, this.state.profile)
      else { this.state.connection = 'ready'; this.state.activity = ''; void this.refreshSettings() }
      if (connectionGeneration !== this.connectionGeneration || this.state.connection !== 'ready') return
      this.activeTimer = setInterval(() => { void this.refreshActiveSessions(); void this.refreshTasks() }, 5000)
      this.attempts = 0
      if (this.state.searchQuery.trim()) this.searchConversations(this.state.searchQuery)
    } catch (error) {
      if (connectionGeneration !== this.connectionGeneration || this.stopped) return
      if (this.handleAuth(error)) return
      if (error instanceof HttpError || !(error instanceof ConnectionLost || error instanceof TypeError)) {
        this.state.connection = 'failed'
        this.state.error = errorMessage(error)
      } else this.scheduleReconnect(error)
    }
  }

  private async checkRejectedSocket() {
    this.state.connection = 'failed'
    this.state.error = 'Hermes rejected the WebSocket. Check its Origin/Host policy and proxy configuration.'
    if (this.state.authRequired) {
      try { await this.api.request('/api/auth/me') }
      catch (error) { this.handleAuth(error) }
    }
  }

  private scheduleReconnect(error?: unknown) {
    if (this.stopped) return
    this.state.connection = 'reconnecting'
    if (error) this.state.error = errorMessage(error)
    else if (!this.state.error) this.state.error = 'Unable to connect to Hermes. Retrying…'
    this.state.activity = 'Connection lost. Hermes may still be running.'
    clearTimeout(this.retryTimer)
    const delay = Math.min(1000 * 2 ** this.attempts++, 30_000)
    this.retryTimer = setTimeout(() => { void this.connect() }, delay)
  }

  async refreshSessions(more = false) {
    if (this.state.listLoading) return
    const connectionGeneration = this.connectionGeneration
    this.state.listLoading = true
    this.state.listError = ''
    try {
      const page = await this.api.sessions(this.configuredProfile, more ? this.state.sessions.length : 0)
      if (this.stopped || connectionGeneration !== this.connectionGeneration) return
      if (Object.values(page.storage || {}).includes('corrupt')) throw new Error('Hermes session storage is unavailable.')
      this.state.sessions = more ? [...this.state.sessions, ...page.sessions.filter(row => !this.state.sessions.some(existing => existing.id === row.id))] : page.sessions
      this.state.total = page.total
      void this.refreshActiveSessions()
    } catch (error) {
      if (this.stopped || connectionGeneration !== this.connectionGeneration) return
      if (!this.handleAuth(error)) this.state.listError = errorMessage(error)
    } finally { this.state.listLoading = false }
  }

  private applyModelInfo(info: SessionModelInfo) {
    if (typeof info.model === 'string') this.state.model = info.model
    if (typeof info.provider === 'string') this.state.provider = info.provider
    if (typeof info.reasoning_effort === 'string') this.state.reasoning = info.reasoning_effort
    if (typeof info.reasoning_effort_wire === 'string') this.state.reasoningWire = info.reasoning_effort_wire
    if (['model', 'provider', 'reasoning_effort', 'reasoning_effort_wire'].some(key => typeof info[key as keyof SessionModelInfo] === 'string')) this.settingsRevision++
  }

  async refreshSettings() {
    if (this.stopped || this.state.connection !== 'ready' || this.state.settingsPending || this.settingsMutation) return
    const read = ++this.settingsReadGeneration
    const generation = this.selectionGeneration
    const connection = this.connectionGeneration
    const revision = this.settingsRevision
    this.state.settingsLoading = true
    this.state.settingsError = ''
    try {
      const [inventory, reasoning] = await Promise.all([
        this.gateway.request<ModelInventory>('model.options', { session_id: this.state.runtime || undefined, profile: this.state.profile, explicit_only: true }),
        this.gateway.request<{ value?: string }>('config.get', { key: 'reasoning', session_id: this.state.runtime || undefined, profile: this.state.profile }),
      ])
      if (this.stopped || read !== this.settingsReadGeneration || generation !== this.selectionGeneration || connection !== this.connectionGeneration) return
      if (!Array.isArray(inventory.providers)) throw new Error('Model choices are unavailable from this Hermes gateway.')
      this.state.modelProviders = inventory.providers
      if (revision === this.settingsRevision) {
        this.state.model = inventory.model || this.state.model
        this.state.provider = inventory.provider || this.state.provider
        this.state.reasoning = reasoning.value || this.state.reasoning
      }
    } catch (error) {
      if (!this.stopped && read === this.settingsReadGeneration && generation === this.selectionGeneration && connection === this.connectionGeneration) this.state.settingsError = errorMessage(error)
    } finally { if (read === this.settingsReadGeneration) this.state.settingsLoading = false }
  }

  private async ensureSettingsSession(): Promise<number | undefined> {
    if (this.state.connection !== 'ready' || this.state.running || this.state.sending || this.state.actionPending || this.settingsMutation || this.stopped) return undefined
    this.settingsMutation = true
    this.state.settingsPending = true
    if (!this.state.runtime) {
      const draft = this.state.draft
      const creation = this.newChat()
      const generation = this.selectionGeneration
      await creation
      if (generation !== this.selectionGeneration) {
        this.settingsMutation = false
        this.state.settingsPending = false
        void this.refreshSettings()
        return undefined
      }
      this.state.draft = draft
    }
    const ready = Boolean(this.state.runtime && this.state.connection === 'ready')
    this.state.settingsPending = ready
    if (!ready) this.settingsMutation = false
    return ready ? this.selectionGeneration : undefined
  }

  private settingsSelectionCurrent(generation: number | undefined): generation is number {
    if (generation === undefined) return false
    if (generation === this.selectionGeneration && this.state.connection === 'ready' && !this.stopped) return true
    this.settingsMutation = false
    this.state.settingsPending = false
    void this.refreshSettings()
    return false
  }

  async chooseModel(choice: ModelChoice, confirmed = false) {
    const provider = this.state.modelProviders.find(provider => provider.slug === choice.provider)
    if (!provider?.models.includes(choice.model) || provider.authenticated === false || provider.unavailable_models?.includes(choice.model)) return
    if (confirmed && (!this.state.modelConfirmation || this.state.modelConfirmation.model !== choice.model || this.state.modelConfirmation.provider !== choice.provider)) return
    const generation = await this.ensureSettingsSession()
    if (!this.settingsSelectionCurrent(generation)) return
    this.state.settingsPending = true
    this.state.settingsError = ''
    this.state.settingsNotice = ''
    this.state.modelConfirmation = undefined
    this.settingsRevision++
    try {
      const result = await this.gateway.request<ModelChangeResult>('config.set', {
        key: 'model', value: modelSwitchValue(choice), session_id: this.state.runtime,
        profile: this.state.profile, scope: 'session', confirm_expensive_model: confirmed,
      }, 300_000)
      if (generation !== this.selectionGeneration || this.stopped) return
      if (result.confirm_required) {
        this.state.modelConfirmation = { ...choice, message: result.confirm_message || 'Hermes requires confirmation before switching to this model.' }
        return
      }
      if (result.info) this.applyModelInfo(result.info)
      else if (!result.deferred) { this.state.model = choice.model; this.state.provider = choice.provider; this.state.reasoningWire = '' }
      this.state.settingsNotice = [result.warning, result.deferred ? 'Model change queued for the next turn.' : ''].filter(Boolean).join(' ')
    } catch (error) {
      if (generation === this.selectionGeneration && !this.stopped) this.state.settingsError = error instanceof ConnectionLost
        ? 'The model change may have reached Hermes. Reconnect to check its current setting.' : errorMessage(error)
    } finally {
      this.settingsMutation = false
      this.state.settingsPending = false
      if (!this.state.settingsError) void this.refreshSettings()
    }
  }

  async chooseReasoning(effort: string) {
    if (!reasoningEfforts.includes(effort)) return
    const generation = await this.ensureSettingsSession()
    if (!this.settingsSelectionCurrent(generation)) return
    const revision = ++this.settingsRevision
    this.state.settingsPending = true
    this.state.settingsError = ''
    this.state.settingsNotice = ''
    try {
      const result = await this.gateway.request<{ value?: string }>('config.set', {
        key: 'reasoning', value: effort, scope: 'session', session_id: this.state.runtime, profile: this.state.profile,
      })
      if (generation !== this.selectionGeneration || this.stopped) return
      if (revision === this.settingsRevision && result.value) { this.state.reasoning = result.value; this.state.reasoningWire = '' }
    } catch (error) {
      if (generation === this.selectionGeneration && !this.stopped) this.state.settingsError = error instanceof ConnectionLost
        ? 'The reasoning change may have reached Hermes. Reconnect to check its current setting.' : errorMessage(error)
    } finally {
      this.settingsMutation = false
      this.state.settingsPending = false
      if (!this.state.settingsError) void this.refreshSettings()
    }
  }

  private resetSettings() {
    this.settingsReadGeneration++
    this.state.settingsLoading = false
    this.state.settingsPending = this.settingsMutation
    this.state.settingsError = ''
    this.state.settingsNotice = ''
    this.state.modelConfirmation = undefined
    this.state.model = ''
    this.state.provider = ''
    this.state.reasoning = ''
    this.state.reasoningWire = ''
  }

  visibleSessions(): SessionRow[] {
    const query = this.state.searchQuery.trim().toLocaleLowerCase()
    if (!query) return this.state.sessions
    const titleMatches = this.state.sessions.filter(session =>
      (session.title || '').toLocaleLowerCase().includes(query) || session.id.toLocaleLowerCase().includes(query))
    const seen = new Set<string>()
    return [...titleMatches, ...this.state.searchResults].filter(session => {
      const key = JSON.stringify([session.profile, session.id])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  searchConversations(query: string) {
    clearTimeout(this.searchTimer)
    const generation = ++this.searchGeneration
    this.state.searchQuery = query
    this.state.searchResults = []
    this.state.searchError = ''
    this.state.searchLoading = Boolean(query.trim())
    if (!query.trim() || this.stopped) return
    this.searchTimer = setTimeout(() => { void this.fetchSearch(query.trim(), generation) }, 250)
  }

  private async fetchSearch(query: string, generation: number) {
    const connection = this.connectionGeneration
    try {
      const result = await this.api.searchSessions(query, this.configuredProfile)
      if (this.stopped || generation !== this.searchGeneration || connection !== this.connectionGeneration) return
      this.state.searchResults = result.results
    } catch (error) {
      if (!this.stopped && generation === this.searchGeneration && connection === this.connectionGeneration && !this.handleAuth(error)) {
        this.state.searchError = errorMessage(error)
      }
    } finally {
      if (!this.stopped && generation === this.searchGeneration) this.state.searchLoading = false
    }
  }

  hasUnreadReply(row: SessionRow) {
    const profile = row.profile || this.configuredProfile || this.state.profile
    return this.state.unreadReplies.some(reply => reply.id === row.id && reply.profile === profile)
  }

  private rememberRuntime() {
    if (this.state.runtime && this.state.selected) this.runtimeSessions.set(this.state.runtime, { id: this.state.selected, profile: this.state.profile })
  }

  private markReplyRead() {
    this.state.unreadReplies = this.state.unreadReplies.filter(reply => reply.id !== this.state.selected || reply.profile !== this.state.profile)
  }

  private observeReply(event: GatewayEvent) {
    if (this.stopped || !['message.complete', 'background.complete'].includes(event.type) || !event.session_id) return
    const session = this.runtimeSessions.get(event.session_id)
    if (!session) return
    if (event.seq !== undefined) {
      const previous = this.replySequences.get(event.session_id) || 0
      if (event.seq <= previous) return
      this.replySequences.set(event.session_id, event.seq)
    }
    if (event.payload?.error || ['interrupted', 'failed', 'error'].includes(String(event.payload?.status))) return
    if (session.id === this.state.selected && session.profile === this.state.profile && this.state.connection === 'ready') return
    if (!this.state.unreadReplies.some(reply => reply.id === session.id && reply.profile === session.profile)) {
      this.state.unreadReplies.push(session)
    }
  }

  sessionStatus(row: SessionRow): 'working' | 'waiting' | undefined {
    const profile = row.profile || this.configuredProfile || this.state.profile
    if (row.id === this.state.selected && this.state.runtime && profile === this.state.profile) {
      if (!this.state.running) return this.state.tasks.some(taskRunning) ? 'working' : undefined
      return this.state.approvals.length || this.state.requests.length ? 'waiting' : 'working'
    }
    const active = this.state.activeSessions.find(session => session.session_key === row.id && session.profile === profile)
    return active?.status === 'working' || active?.status === 'waiting' ? active.status : undefined
  }

  private async refreshActiveSessions() {
    if (this.stopped || !['ready', 'recovering'].includes(this.state.connection)) return
    const generation = this.connectionGeneration
    if (this.activeRequestGeneration === generation) return
    this.activeRequestGeneration = generation
    const revision = this.activeRevision
    const profile = this.configuredProfile || this.state.sessions[0]?.profile || this.state.profile
    try {
      const result = await this.gateway.request<{ sessions: ActiveSession[] }>('session.active_list', { profile })
      if (!this.stopped && generation === this.connectionGeneration && revision === this.activeRevision && Array.isArray(result.sessions)) {
        this.state.activeSessions = result.sessions.map(session => ({ ...session, profile }))
        for (const session of result.sessions) this.runtimeSessions.set(session.id, { id: session.session_key, profile })
      }
    } catch {
      // Older gateways may not support this optional read-only status probe.
      // Selected-conversation status still comes from resume and live events.
    } finally {
      if (this.activeRequestGeneration === generation) this.activeRequestGeneration = undefined
    }
  }

  private taskScope() { return JSON.stringify([this.state.profile, this.state.selected]) }

  private async refreshTasks() {
    if (this.stopped || this.state.connection !== 'ready' || !this.state.runtime || this.taskRequest) return
    const request = {}
    this.taskRequest = request
    const generation = this.selectionGeneration
    const connection = this.connectionGeneration
    const revision = this.taskRevision
    try {
      const roster = await this.gateway.request<SubagentRoster>('subagent.list', {
        session_id: this.state.runtime, profile: this.state.profile,
      })
      if (this.stopped || generation !== this.selectionGeneration || connection !== this.connectionGeneration || revision !== this.taskRevision) return
      if (!Array.isArray(roster.subagents)) return
      this.state.tasks = anchorFinishedTasks(reconcileTasks(this.state.tasks, roster), this.state.messages)
      this.taskCache.set(this.taskScope(), this.state.tasks)
      this.state.taskError = ''
    } catch {
      if (!this.stopped && generation === this.selectionGeneration && connection === this.connectionGeneration) {
        this.state.taskError = 'Background task status unavailable.'
      }
    } finally { if (this.taskRequest === request) this.taskRequest = undefined }
  }

  private applyTaskEvent(event: GatewayEvent) {
    const tasks = taskEvent(this.state.tasks, event)
    if (tasks === this.state.tasks) return
    this.taskRevision++
    this.state.tasks = anchorFinishedTasks(tasks, this.state.messages)
    this.taskCache.set(this.taskScope(), this.state.tasks)
  }

  private rememberActiveSession() {
    this.rememberRuntime()
    if (this.state.runtime && this.state.selected) {
      const current: ActiveSession & { profile?: string } = {
        id: this.state.runtime, session_key: this.state.selected, profile: this.state.profile,
        status: this.state.running || this.state.tasks.some(taskRunning) ? (this.state.approvals.length || this.state.requests.length ? 'waiting' : 'working') : 'idle',
      }
      this.state.activeSessions = [...this.state.activeSessions.filter(session => session.id !== current.id || session.profile !== current.profile), current]
      this.activeRevision++
    }
  }

  async open(id: string, profile = this.configuredProfile) {
    if (['expired', 'reconnecting', 'connecting', 'closed'].includes(this.state.connection)) return
    this.taskCache.set(this.taskScope(), this.state.tasks)
    this.rememberActiveSession()
    this.drafts.set(this.state.selected, this.state.draft)
    const generation = ++this.selectionGeneration
    const previousId = this.state.selected
    this.state.selected = id
    this.state.profile = profile
    this.state.tasks = this.taskCache.get(this.taskScope()) || []
    this.state.taskError = ''
    this.taskRequest = undefined
    this.state.runtime = ''
    this.resetSettings()
    this.state.olderLoading = false
    this.state.draft = this.drafts.get(id) || ''
    this.state.uncertain = this.uncertain.has(id)
    this.state.sending = false
    this.state.actionPending = false
    this.state.error = ''
    this.state.activity = ''
    this.state.approvals = []
    this.state.requests = []
    this.state.title = this.state.sessions.find(row => row.id === id)?.title || 'Conversation'
    if (id !== previousId) { this.state.messages = []; this.state.hasOlder = false }
    this.location.select(id)
    this.state.connection = 'recovering'
    this.recovering = true
    this.buffered = []
    this.bufferedRequests = []

    try {
      // Read the bounded transcript before the live snapshot. If a turn commits
      // in between, read again so the snapshot cannot retire unseen messages.
      let page: HistoryPage
      try {
        page = await this.api.history(id, profile)
      } catch (error) {
        if (generation !== this.selectionGeneration) return
        if (!(error instanceof HttpError) || error.status !== 404) throw error
        // Fresh Hermes drafts have a stored key before their first database row.
        // Resume that exact key; accept missing history only for a proven empty draft.
        const draftSnapshot = await this.gateway.request<Snapshot>('session.resume', {
          source: 'desktop',
          session_id: id, profile, omit_messages: true,
          inline_images: false, close_on_disconnect: false,
        })
        if (generation !== this.selectionGeneration) return
        const stored = draftSnapshot.stored_session_id || draftSnapshot.info.stored_session_id || id
        if (draftSnapshot.info.lazy && draftSnapshot.message_count === 0 && !draftSnapshot.running && !draftSnapshot.inflight) {
          page = {
            session_id: stored, profile: draftSnapshot.info.profile_name || profile, messages: [],
            pagination: { returned: 0, offset: 0, limit: 50 },
          }
        } else page = await this.api.history(stored, profile)
      }
      if (generation !== this.selectionGeneration) return
      let snapshot = await this.gateway.request<Snapshot>('session.resume', {
        source: 'desktop',
        session_id: page.session_id, profile: page.profile || profile,
        omit_messages: true, inline_images: false, close_on_disconnect: false,
      })
      if (generation !== this.selectionGeneration) return
      for (let pass = 0; this.buffered.some(event => event.type === 'message.complete' && event.session_id === snapshot.session_id); pass++) {
        if (pass >= 3) throw new Error('Hermes is changing too quickly to recover. Retry when the turn settles.')
        this.buffered = []
        page = await this.api.history(snapshot.stored_session_id || page.session_id, page.profile || profile)
        if (generation !== this.selectionGeneration) return
        snapshot = await this.gateway.request<Snapshot>('session.resume', {
          source: 'desktop',
          session_id: page.session_id, profile: page.profile || profile, omit_messages: true,
          inline_images: false, close_on_disconnect: false,
        })
        if (generation !== this.selectionGeneration) return
      }
      const eventBoundary = this.buffered.length
      const requestBoundary = this.bufferedRequests.length
      const stored = snapshot.stored_session_id || snapshot.info.stored_session_id || page.session_id
      this.state.selected = stored
      this.state.runtime = snapshot.session_id
      this.state.profile = page.profile || profile
      this.applyModelInfo(snapshot.info)
      this.state.title = snapshot.info.title || this.state.title
      this.state.messages = restoreInflight(historyMessages(page), snapshot)
      this.state.historyOffset = page.pagination.returned
      this.state.hasOlder = page.pagination.returned === page.pagination.limit
      this.state.running = Boolean(snapshot.running ?? snapshot.info.running)
      this.state.activity = this.state.running ? 'Hermes is working' : ''
      this.state.error = snapshot.inflight?.error || ''
      this.state.approvals = snapshot.pending_approval ? [snapshot.pending_approval] : []
      this.state.requests = (snapshot.open_requests || []).filter(request => this.matchesRequest(request))
      const approvals = await this.gateway.request<{ approvals: Approval[] }>('approval.pending', {
        session_id: snapshot.session_id, profile: this.state.profile,
      })
      if (generation !== this.selectionGeneration) return
      this.state.approvals = approvals.approvals
      if (stored !== id) {
        this.state.draft ||= this.drafts.get(stored) || ''
        this.drafts.set(stored, this.state.draft)
        this.drafts.delete(id)
        if (this.uncertain.delete(id)) this.uncertain.add(stored)
        this.state.uncertain = this.uncertain.has(stored)
        this.state.sessions = this.state.sessions.map(row => row.id === id ? { ...row, id: stored } : row)
      }
      this.location.select(stored)
      for (const event of this.buffered.slice(0, eventBoundary)) {
        if (event.session_id === snapshot.session_id) this.applyTaskEvent(event)
      }
      for (const event of this.buffered.slice(0, eventBoundary)) {
        if (event.session_id === snapshot.session_id && event.seq !== undefined) {
          this.sequence.set(event.session_id, Math.max(this.sequence.get(event.session_id) || 0, event.seq))
        }
      }
      const eventsAfterSnapshot = this.buffered.slice(eventBoundary)
      const requestsAfterSnapshot = this.bufferedRequests.slice(requestBoundary)
      this.recovering = false
      this.buffered = []
      this.bufferedRequests = []
      this.state.connection = 'ready'
      this.rememberRuntime()
      this.markReplyRead()
      for (const request of requestsAfterSnapshot) {
        if (this.matchesRequest(request)) this.addRequest(request)
      }
      for (const event of eventsAfterSnapshot) this.receiveEvent(event)
      void this.refreshTasks()
      void this.refreshSettings()
    } catch (error) {
      if (generation !== this.selectionGeneration) return
      this.recovering = false
      if (this.handleAuth(error)) return
      if (error instanceof ConnectionLost) this.scheduleReconnect()
      else { this.state.connection = 'failed'; this.state.error = errorMessage(error) }
    }
  }

  async newChat() {
    if (this.state.connection !== 'ready' || this.state.sending || this.state.actionPending) return
    this.taskCache.set(this.taskScope(), this.state.tasks)
    this.rememberActiveSession()
    this.drafts.set(this.state.selected, this.state.draft)
    const generation = ++this.selectionGeneration
    this.state.connection = 'recovering'
    try {
      const result = await this.gateway.request<Snapshot>('session.create', {
        source: 'desktop',
        profile: this.configuredProfile, close_on_disconnect: false,
        idempotency_key: crypto.randomUUID(),
      })
      if (generation !== this.selectionGeneration) return
      this.state.selected = result.stored_session_id || result.info.stored_session_id || ''
      this.state.runtime = result.session_id
      this.state.profile = this.configuredProfile || result.info.profile_name || undefined
      this.resetSettings()
      this.applyModelInfo(result.info)
      this.state.messages = []
      this.state.tasks = []
      this.state.taskError = ''
      this.taskRequest = undefined
      this.state.approvals = []
      this.state.requests = []
      this.state.title = 'New conversation'
      this.state.draft = ''
      this.state.running = false
      this.state.uncertain = false
      this.state.error = ''
      this.state.activity = ''
      this.state.hasOlder = false
      this.location.select(this.state.selected)
      this.state.connection = 'ready'
      this.rememberRuntime()
      this.markReplyRead()
      await this.refreshSessions()
      void this.refreshSettings()
    } catch (error) {
      if (generation !== this.selectionGeneration) return
      if (this.handleAuth(error)) return
      this.state.error = error instanceof ConnectionLost ? 'Chat creation outcome is unknown. Check the session list before creating another chat.' : errorMessage(error)
      if (error instanceof ConnectionLost) this.scheduleReconnect()
      else this.state.connection = 'ready'
    }
  }

  async send() {
    if (!this.canSend()) return
    const text = this.state.draft.trim()
    const selected = this.state.selected
    const runtime = this.state.runtime
    const profile = this.state.profile
    const generation = this.selectionGeneration
    this.state.sending = true
    this.state.error = ''
    this.state.running = true
    this.state.messages.push({ key: `submitted-${crypto.randomUUID()}`, role: 'user', text })
    try {
      const result = await this.gateway.request<{ status?: string }>('prompt.submit', { session_id: runtime, profile, text })
      this.drafts.set(selected, '')
      if (this.state.selected === selected && this.state.draft.trim() === text) this.state.draft = ''
      if (generation !== this.selectionGeneration) return
      if (result.status && result.status !== 'streaming') this.state.activity = `Hermes accepted the prompt (${result.status}).`
    } catch (error) {
      if (error instanceof ConnectionLost) {
        this.uncertain.add(selected)
        this.drafts.set(selected, text)
      }
      if (generation !== this.selectionGeneration) return
      this.state.uncertain = this.uncertain.has(selected)
      this.state.error = errorMessage(error)
      if (error instanceof ConnectionLost) this.scheduleReconnect()
      else {
        await this.open(selected, profile)
        if (this.state.selected === selected) this.state.error = errorMessage(error)
      }
    } finally {
      if (generation === this.selectionGeneration) this.state.sending = false
    }
  }

  canSend() {
    return this.state.connection === 'ready' && Boolean(this.state.runtime && this.state.draft.trim()) &&
      !this.state.running && !this.state.sending && !this.state.actionPending && !this.state.settingsPending && !this.state.modelConfirmation && !this.state.uncertain
  }

  acknowledgeUncertain() {
    this.uncertain.delete(this.state.selected)
    this.state.uncertain = false
  }

  async stop() {
    await this.action('session.interrupt', {}, result => {
      if ((result as { status: string }).status === 'not_interrupted') {
        this.state.activity = 'Hermes did not interrupt a turn. Recovering its current state.'
        void this.open(this.state.selected, this.state.profile)
      } else this.state.activity = 'Stop requested; waiting for Hermes.'
    })
  }

  async answer(request: ServerRequest, result: Record<string, unknown>) {
    await this.action('request.answer', { id: request.id, result }, response => {
      if ((response as { status: string }).status === 'expired') this.state.error = 'This request expired or was already answered.'
      this.state.requests = this.state.requests.filter(entry => entry.id !== request.id)
      if (request.method === 'approval') {
        this.state.approvals = this.state.approvals.filter(approval => approval.request_id !== request.params.request_id)
      }
    })
  }

  async approve(approval: Approval, choice: string) {
    await this.action('approval.respond', { request_id: approval.request_id, choice }, response => {
      if (!(response as { resolved: number }).resolved) this.state.error = 'This approval expired or was already answered.'
      this.state.approvals = this.state.approvals.filter(entry => entry.request_id !== approval.request_id)
      this.state.requests = this.state.requests.filter(entry => entry.params.request_id !== approval.request_id)
    })
  }

  private async action(method: string, params: Record<string, unknown>, apply?: (result: unknown) => void) {
    if (this.state.connection !== 'ready' || this.state.actionPending) return
    const generation = this.selectionGeneration
    this.state.actionPending = true
    this.state.error = ''
    try {
      const result = await this.gateway.request(method, { session_id: this.state.runtime, profile: this.state.profile, ...params }, 300_000)
      if (generation === this.selectionGeneration) apply?.(result)
    } catch (error) {
      if (generation === this.selectionGeneration) this.state.error = errorMessage(error)
    } finally { if (generation === this.selectionGeneration) this.state.actionPending = false }
  }

  async older() {
    if (!this.state.hasOlder || this.state.olderLoading || this.state.connection !== 'ready') return
    const generation = this.selectionGeneration
    const id = this.state.selected
    this.state.olderLoading = true
    try {
      const page = await this.api.history(id, this.state.profile, this.state.historyOffset)
      if (generation !== this.selectionGeneration) return
      if (page.session_id !== id) { await this.open(id, this.state.profile); return }
      this.state.messages = mergeHistory(historyMessages(page), this.state.messages)
      this.state.historyOffset += page.pagination.returned
      this.state.hasOlder = page.pagination.returned === page.pagination.limit
    } catch (error) {
      if (generation === this.selectionGeneration && !this.handleAuth(error)) this.state.error = errorMessage(error)
    } finally { this.state.olderLoading = false }
  }

  async rename(title: string) {
    const id = this.state.selected
    try {
      const result = await this.api.rename(id, title, this.state.profile)
      if (this.state.selected === id) this.state.title = result.title || 'Conversation'
      await this.refreshSessions()
    } catch (error) { if (!this.handleAuth(error)) this.state.error = errorMessage(error) }
  }

  async deleteSelected() {
    const id = this.state.selected
    try {
      await this.api.delete(id, this.state.profile)
      if (this.state.selected === id) {
        this.selectionGeneration++
        this.drafts.delete(id)
        this.uncertain.delete(id)
        this.markReplyRead()
        Object.assign(this.state, {
          selected: '', runtime: '', title: 'New conversation', messages: [], tasks: [], taskError: '',
          approvals: [], requests: [], draft: '', running: false, uncertain: false,
          activity: '', hasOlder: false,
        })
        this.resetSettings()
        this.location.select('')
        void this.refreshSettings()
      }
      await this.refreshSessions()
    } catch (error) { if (!this.handleAuth(error)) this.state.error = errorMessage(error) }
  }

  private receiveEvent(event: GatewayEvent) {
    if (event.type === 'gateway.ready') return
    this.observeReply(event)
    if (event.type === 'sessions.changed') { void this.refreshSessions(); return }
    if (this.recovering) { this.buffered.push(event); return }
    const payload = event.payload || {}
    if (event.type === 'session.title' && payload.session_id === this.state.selected && typeof payload.title === 'string') {
      this.state.title = payload.title
      void this.refreshSessions()
    }
    if (!event.session_id || event.session_id !== this.state.runtime) return
    if (event.seq !== undefined) {
      const last = this.sequence.get(event.session_id) || 0
      if (event.seq <= last) return
      this.sequence.set(event.session_id, event.seq)
    }
    this.applyTaskEvent(event)
    switch (event.type) {
      case 'message.start':
        this.state.running = true
        this.state.messages.push({ key: `live-${crypto.randomUUID()}`, role: 'assistant', text: '' })
        break
      case 'message.delta': {
        let message = this.state.messages.at(-1)
        if (message?.role !== 'assistant') {
          message = { key: `live-${crypto.randomUUID()}`, role: 'assistant', text: '' }
          this.state.messages.push(message)
          message = this.state.messages.at(-1)!
        }
        message.text += typeof payload.text === 'string' ? payload.text : ''
        this.state.running = true
        break
      }
      case 'message.complete': {
        this.state.running = false
        this.state.activity = ''
        const selected = this.state.selected
        const failure = typeof payload.error === 'string' ? payload.error : ''
        void this.open(selected, this.state.profile).then(() => {
          if (this.state.selected === selected) {
            if (failure) this.state.error = failure
            if (payload.status === 'interrupted') this.state.activity = 'Turn stopped.'
          }
          return this.refreshSessions()
        })
        break
      }
      case 'message.interim':
        if (!payload.already_streamed && typeof payload.text === 'string') {
          this.state.messages.push({ key: `interim-${crypto.randomUUID()}`, role: 'assistant', text: payload.text })
        }
        this.state.messages.push({ key: `live-${crypto.randomUUID()}`, role: 'assistant', text: '' })
        break
      case 'tool.start':
      case 'tool.complete': {
        if (typeof payload.tool_id !== 'string' || !payload.tool_id) break
        const turnStart = this.state.messages.findLastIndex(message => message.role === 'user')
        let message = this.state.messages.slice(turnStart + 1).find(message => message.tool?.id === payload.tool_id)
        if (!message) {
          this.state.messages.push({
            key: `tool-${crypto.randomUUID()}`, role: 'tool', text: '',
            name: typeof payload.name === 'string' ? payload.name : 'Tool',
            tool: { id: payload.tool_id, status: 'running' },
          })
          message = this.state.messages.at(-1)!
        }
        const tool = message.tool!
        if (event.type === 'tool.start' && tool.status === 'completed') break
        if (typeof payload.name === 'string') message.name = payload.name
        if (typeof payload.context === 'string') tool.context = payload.context
        else if (typeof payload.preview === 'string') tool.context = payload.preview
        if (payload.args && typeof payload.args === 'object') tool.args = JSON.stringify(payload.args, null, 2)
        else if (typeof payload.args_text === 'string') tool.args = payload.args_text
        tool.status = event.type === 'tool.start' ? 'running' : 'completed'
        if (event.type === 'tool.complete') {
          message.text = typeof payload.result === 'string' ? payload.result
            : payload.result != null ? JSON.stringify(payload.result, null, 2)
            : typeof payload.result_text === 'string' ? payload.result_text : ''
          if (typeof payload.summary === 'string') tool.summary = payload.summary
          if (typeof payload.duration_s === 'number' && Number.isFinite(payload.duration_s)) tool.duration = payload.duration_s
        } else this.state.running = true
        this.state.activity = ''
        break
      }
      case 'status.update': this.state.activity = typeof payload.text === 'string' ? payload.text : ''; break
      case 'session.info':
        this.applyModelInfo(payload)
        if (typeof payload.running === 'boolean') this.state.running = payload.running
        if (typeof payload.stored_session_id === 'string' && payload.stored_session_id !== this.state.selected) {
          const old = this.state.selected
          this.drafts.set(payload.stored_session_id, this.state.draft)
          if (this.uncertain.has(old)) this.uncertain.add(payload.stored_session_id)
          void this.open(payload.stored_session_id, this.state.profile)
        }
        break
      case 'request.cancel':
        this.state.requests = this.state.requests.filter(request => request.id !== payload.id)
        this.state.activity = 'A pending request was withdrawn by Hermes.'
        break
      case 'session.reclaimed':
        this.state.error = 'Hermes reclaimed this runtime session. Reconnect to recover it.'
        this.state.connection = 'failed'
        break
      case 'approval.cancelled':
        this.state.approvals = []
        this.state.requests = this.state.requests.filter(request => request.method !== 'approval')
        this.state.activity = 'Pending approvals were cancelled by Hermes.'
        break
      case 'error': this.state.error = typeof payload.message === 'string' ? payload.message : 'Hermes reported an error.'; break
    }
  }

  private matchesRequest(request: ServerRequest) {
    return [request.params.session_id, request.params.gateway_session_id].some(id => id === this.state.runtime || id === this.state.selected)
  }

  private addRequest(request: ServerRequest) {
    this.state.requests = [...this.state.requests.filter(entry => entry.id !== request.id), request]
  }

  private handleAuth(error: unknown): boolean {
    if (!(error instanceof HttpError) || error.status !== 401) return false
    clearTimeout(this.retryTimer)
    clearInterval(this.activeTimer)
    this.connectionGeneration++
    this.selectionGeneration++
    this.gateway.close()
    this.state.connection = 'expired'
    this.state.identity = ''
    this.state.error = 'Your Hermes login has expired. Sign in to continue.'
    return true
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unable to reach Hermes.'
}
