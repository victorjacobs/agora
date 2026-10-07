<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { CronApi, cronDraft, cronPayload, type CronJob, type CronRun } from './hermes/cron'
import { conversationTurns, historyMessages, mergeHistory } from './hermes/transcript'
import type { Message } from './hermes/types'
import ConversationTurn from './ConversationTurn.vue'
import CronRunDialog from './CronRunDialog.vue'

const props = defineProps<{ active: boolean; connected: boolean; profile?: string; requestedJob?: string; api?: CronApi }>()
const emit = defineEmits<{ jobs: [jobs: CronJob[]] }>()
const api = props.api || new CronApi()
const jobs = ref<CronJob[]>([])
const selected = ref('')
let requestedSelection = props.requestedJob || ''
watch(() => props.requestedJob, id => { requestedSelection = id || '' })
const profile = ref('')
const runs = ref<CronRun[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const editing = ref(false)
const draft = reactive(cronDraft())
const confirmation = ref<'trigger' | 'delete'>()
const limit = ref(20)
const selectedRun = ref<CronRun>()
const messages = ref<Message[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const older = ref(false)
const offset = ref(0)
let generation = 0
let selectionGeneration = 0
let historyGeneration = 0
let timer: ReturnType<typeof setInterval> | undefined
const job = computed(() => jobs.value.find(job => job.id === selected.value))
const turns = computed(() => conversationTurns(messages.value, false))
const paused = computed(() => job.value?.enabled === false || job.value?.state === 'paused')
const changed = computed(() => !job.value || Object.keys(cronPayload(draft, job.value)).length > 0)
const date = (value?: string | number | null) => {
  if (value === undefined || value === null || value === '') return '—'
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}
const failure = (value: unknown) => value instanceof Error ? value.message : 'Cron request failed.'

function clearHistory() {
  historyGeneration++
  selectedRun.value = undefined
  messages.value = []
  historyLoading.value = false
  historyError.value = ''
  older.value = false
}
async function loadRuns() {
  const scope = generation, request = ++selectionGeneration, id = selected.value, owner = profile.value
  if (!id || !owner || !props.active || !props.connected) return
  try {
    const result = await api.runs(owner, id, limit.value)
    if (scope === generation && request === selectionGeneration) runs.value = result.runs
  } catch (value) { if (scope === generation && request === selectionGeneration) error.value = failure(value) }
}
function select(id: string) {
  if (busy.value) return
  selected.value = id
  runs.value = []
  editing.value = false
  confirmation.value = undefined
  error.value = ''; notice.value = ''; limit.value = 20
  clearHistory()
  void loadRuns()
}
function newJob() {
  if (busy.value || !props.connected || !profile.value) return
  select('')
  editing.value = true
  Object.assign(draft, cronDraft())
}
async function refresh() {
  if (!props.active || !props.connected || busy.value || loading.value) return
  const scope = generation
  loading.value = true; error.value = ''
  try {
    const owner = await api.profile(props.profile)
    const result = await api.jobs(owner)
    if (scope !== generation) return
    profile.value = owner
    jobs.value = result
    emit('jobs', result)
    if (requestedSelection) {
      const requested = requestedSelection; requestedSelection = ''
      selected.value = result.some(job => job.id === requested) ? requested : ''
      if (!selected.value) { error.value = 'The requested job is no longer available.'; return }
    }
    if (!editing.value && !result.some(job => job.id === selected.value)) selected.value = result[0]?.id || ''
    await loadRuns()
  } catch (value) { if (scope === generation) error.value = failure(value) }
  finally { if (scope === generation) loading.value = false }
}
function cancelEdit() {
  select(job.value?.id || jobs.value[0]?.id || '')
}
function edit() {
  if (!job.value) return
  Object.assign(draft, cronDraft(job.value)); editing.value = true; confirmation.value = undefined
}
async function mutate(action: 'save' | 'pause' | 'resume' | 'trigger' | 'delete') {
  if (busy.value || !props.connected || !profile.value) return
  const scope = generation, owner = profile.value, current = job.value
  const values = { ...draft }
  busy.value = true; error.value = ''; notice.value = ''; confirmation.value = undefined
  try {
    let created: CronJob | undefined
    if (action === 'save') created = current ? await api.update(owner, current, values) : await api.create(owner, values)
    else if (current) await api.action(owner, current.id, action)
    if (scope !== generation) return
    editing.value = false
    if (created) selected.value = created.id
    if (action === 'delete') { selected.value = ''; clearHistory() }
    notice.value = action === 'save' ? 'Job saved.' : action === 'trigger' ? 'Run requested. Refresh to check progress.' : action === 'delete' ? 'Job deleted.' : action === 'pause' ? 'Job paused.' : 'Job resumed.'
  } catch (value) {
    if (scope === generation) error.value = failure(value) + ' Check the job before trying again; this action has not been retried.'
    return
  } finally {
    busy.value = false
    if (scope !== generation) void refresh()
  }
  if (scope === generation) await refresh()
}
async function readRun(run: CronRun, append = false) {
  if (historyLoading.value || busy.value) return
  const scope = generation, request = ++historyGeneration, owner = profile.value
  if (!append) { messages.value = []; offset.value = 0 }
  selectedRun.value = run; historyLoading.value = true; historyError.value = ''
  try {
    const page = await api.history(run.profile || owner, run.id, offset.value)
    if (scope !== generation || request !== historyGeneration) return
    messages.value = append ? mergeHistory(historyMessages(page), messages.value) : historyMessages(page)
    offset.value = page.pagination.offset + page.pagination.returned
    older.value = page.pagination.returned === page.pagination.limit
  } catch (value) { if (scope === generation && request === historyGeneration) historyError.value = failure(value) }
  finally { if (scope === generation && request === historyGeneration) historyLoading.value = false }
}
watch(() => [props.active, props.connected, props.profile], () => {
  generation++; selectionGeneration++; clearHistory(); loading.value = false
  clearInterval(timer)
  if (!props.active || !props.connected) return
  selected.value = ''; jobs.value = []; runs.value = []; profile.value = ''; editing.value = false; confirmation.value = undefined; emit('jobs', [])
  void refresh()
  timer = setInterval(() => { if (!editing.value && !confirmation.value) void refresh() }, 15_000)
}, { immediate: true })
onBeforeUnmount(() => { generation++; selectionGeneration++; historyGeneration++; clearInterval(timer) })
const ready = computed(() => !!profile.value && props.connected && !loading.value)
defineExpose({ select, newJob, selected, busy, ready })
</script>

<template>
  <section class="cron-view" aria-label="Cron jobs">
    <div class="cron-width">
      <div class="cron-toolbar"><span class="muted">{{ profile ? `Profile: ${profile}` : '' }}</span><button :disabled="loading || busy || !connected || editing" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button></div>
      <p v-if="!connected" role="status">Connect to Hermes to manage cron jobs.</p>
      <p v-if="error" class="cron-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>
      <form v-if="editing" class="cron-editor" @submit.prevent="mutate('save')">
        <h2>{{ job ? 'Edit job' : 'New job' }}</h2>
        <fieldset :disabled="busy || !connected || !profile">
          <label>Name<input v-model="draft.name" placeholder="Daily briefing" /></label>
          <label>Schedule<input v-model="draft.schedule" required placeholder="0 9 * * *" /><small>Cron expression, interval such as “every 30m”, or a one-time date. Hermes interprets the schedule in its configured timezone.</small></label>
          <label>Prompt<textarea v-model="draft.prompt" rows="5" placeholder="What should Hermes do?" /></label>
          <label>Delivery<input v-model="draft.deliver" required placeholder="local" /><small>Use “local” to save only, or an existing Hermes delivery target.</small></label>
          <label v-if="!job" class="cron-check"><input v-model="draft.paused" type="checkbox" />Create paused</label>
          <details><summary>Execution settings</summary><div class="cron-fields">
            <label>Model<input v-model="draft.model" placeholder="Hermes default" /></label><label>Provider<input v-model="draft.provider" placeholder="Hermes default" /></label>
            <label>Skills<textarea v-model="draft.skills" rows="2" placeholder="One skill name per line" /></label>
            <label>Script<input v-model="draft.script" placeholder="Existing script path on Hermes" /></label><label>Working directory<input v-model="draft.workdir" /></label>
            <label class="cron-check"><input v-model="draft.no_agent" type="checkbox" />Run script only, without an agent</label>
          </div></details>
          <div class="cron-actions"><button type="submit" :disabled="!changed">{{ busy ? 'Saving…' : 'Save job' }}</button><button type="button" @click="cancelEdit">Cancel</button></div>
        </fieldset>
      </form>
      <template v-else-if="job">
        <div class="cron-job-heading"><div><h2>{{ job.name || job.id }}</h2><span class="cron-status">{{ paused ? 'Paused' : job.state || 'Scheduled' }}</span></div><div class="cron-actions"><button :disabled="busy || !connected" @click="edit">Edit</button><button :disabled="busy || !connected" @click="mutate(paused ? 'resume' : 'pause')">{{ paused ? 'Resume' : 'Pause' }}</button><button :disabled="busy || !connected" @click="confirmation = 'trigger'">Run now</button><button :disabled="busy || !connected" @click="confirmation = 'delete'">Delete</button></div></div>
        <div v-if="confirmation" class="cron-confirm" role="alert"><p>{{ confirmation === 'delete' ? 'Delete this scheduled job?' : paused ? 'Run this job now? Hermes also resumes a paused job when it is triggered.' : 'Run this job now?' }}</p><button :disabled="busy || !connected" @click="mutate(confirmation!)">{{ confirmation === 'delete' ? 'Delete job' : 'Run job' }}</button><button @click="confirmation = undefined">Cancel</button></div>
        <dl class="cron-facts"><div><dt>Schedule</dt><dd>{{ job.schedule_display || cronDraft(job).schedule }}</dd></div><div><dt>Next run</dt><dd>{{ date(job.next_run_at) }}</dd></div><div><dt>Last run</dt><dd>{{ date(job.last_run_at) }}</dd></div><div><dt>Last result</dt><dd>{{ job.last_status || '—' }}</dd></div><div><dt>Delivery</dt><dd>{{ job.deliver || 'local' }}</dd></div></dl>
        <p v-if="job.last_error" class="cron-error">{{ job.last_error }}</p>
        <details v-if="job.prompt || job.script" class="cron-prompt"><summary>Task</summary><p v-if="job.prompt">{{ job.prompt }}</p><p v-if="job.script">Script: {{ job.script }}</p></details>
        <h3>Runs</h3><p v-if="!runs.length" class="muted">{{ loading ? 'Loading runs…' : 'No runs returned by Hermes.' }}</p>
        <div class="cron-runs"><article v-for="run in runs" :key="run.id" class="cron-run"><div><strong>{{ date(run.started_at) }}</strong><span v-if="run.is_active" class="cron-running" role="status"><span class="pulse" />Running</span><span v-else class="muted">{{ run.ended_at ? 'Finished' : 'No active run reported' }}</span><p>{{ run.title || run.preview || run.id }}</p><small v-if="run.message_count">{{ run.message_count }} messages · {{ (run.input_tokens || 0) + (run.output_tokens || 0) }} tokens</small></div><button v-if="run.source !== 'cron_output'" :disabled="busy || !connected" @click="readRun(run)">View conversation</button><details v-else-if="run.preview"><summary>Output preview</summary><p class="cron-output">{{ run.preview }}</p></details></article></div>
        <button v-if="runs.length >= limit && limit < 100" :disabled="busy || loading" @click="limit = 100; loadRuns()">Show up to 100 runs</button>

      </template>
      <div v-else-if="!loading && connected && !error" class="cron-empty"><h2>No cron jobs</h2><button :disabled="busy || !profile" @click="newJob">New job</button></div>
    </div>
    <CronRunDialog v-if="selectedRun" :title="selectedRun.title || job?.name || 'Run conversation'" :date="date(selectedRun.started_at)" :refreshing="historyLoading" :connected="connected" @close="clearHistory" @refresh="readRun(selectedRun)">
      <p v-if="historyLoading" role="status">Loading conversation…</p>
      <p v-if="historyError" class="cron-error" role="alert">{{ historyError }}</p>
      <p v-if="!historyLoading && !historyError && !messages.length" class="muted">No messages returned by Hermes.</p>
      <button v-if="older" :disabled="historyLoading || !connected" @click="readRun(selectedRun, true)">Load older messages</button>
      <ConversationTurn v-for="turn in turns" :key="turn.key" :turn="turn" :profile="selectedRun.profile || profile" :thinking="false" />
    </CronRunDialog>
  </section>
</template>

<style scoped>
.cron-view{flex:1;min-height:0;overflow-y:auto;padding:28px 32px}.cron-width{max-width:960px;margin:auto}.cron-toolbar,.cron-job-heading,.cron-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}.cron-toolbar{margin-bottom:24px}.cron-actions{justify-content:flex-start;flex-wrap:wrap}h2{margin:0 0 8px;font-size:22px}h3{font-size:16px}.cron-status,.cron-running{font-size:12px;color:var(--muted)}.cron-running{display:inline-flex;align-items:center;gap:8px}.cron-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:26px 0}.cron-facts dt{font-size:12px;color:var(--muted);margin-bottom:5px}.cron-facts dd{margin:0;font-size:14px;overflow-wrap:anywhere}.cron-prompt,.cron-run,.cron-confirm{border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:16px;margin:12px 0}.cron-prompt p,.cron-output{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.cron-run{display:flex;gap:20px;align-items:center;justify-content:space-between}.cron-run strong{font-size:13px;margin-right:16px}.cron-run p{font-size:14px;margin:8px 0}.cron-run small,.cron-editor small{color:var(--muted);font-size:12px}.cron-error{color:var(--text);background:var(--panel);padding:12px;border-left:3px solid var(--muted);overflow-wrap:anywhere}.cron-editor fieldset{border:0;padding:0;margin:0}.cron-editor label{display:flex;flex-direction:column;gap:7px;margin:16px 0;font-size:13px}.cron-editor input,.cron-editor textarea{width:100%;box-sizing:border-box;background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:10px;font:inherit}.cron-editor textarea{resize:vertical;line-height:1.5}.cron-editor .cron-check{flex-direction:row;align-items:center}.cron-check input{width:auto}.cron-fields{padding:0 8px}.cron-editor summary,.cron-prompt summary,.cron-run summary{cursor:pointer;font-size:13px}.cron-empty{text-align:center;padding:50px 0}.cron-confirm button+button{margin-left:8px}@media(max-width:760px){.cron-view{padding:22px 17px}.cron-job-heading,.cron-run{align-items:flex-start;flex-direction:column}.cron-facts{grid-template-columns:1fr 1fr}}
</style>
