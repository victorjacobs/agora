<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CronApi, type CronJob, type CronRun } from './hermes/cron'
import { createResultReadQueue, resultOutput, resultStatus } from './hermes/results'
import MarkdownMessage from './MarkdownMessage.vue'
import CronRunDialog from './CronRunDialog.vue'
import ConversationTurn from './ConversationTurn.vue'
import { conversationTurns, historyMessages, mergeHistory } from './hermes/transcript'
import type { Message } from './hermes/types'

const props = defineProps<{ active: boolean; connected: boolean; profile?: string; jobId: string; api?: CronApi }>()
const emit = defineEmits<{ jobs: [jobs: CronJob[]]; manage: [id: string] }>()
const api = props.api || new CronApi()
interface Result { key: string; job: CronJob; run: CronRun; output?: string; error?: string; signature?: string }
const jobs = ref<CronJob[]>([])
const results = ref<Result[]>([])
const profile = ref('')
const loading = ref(false)
const error = ref('')
const status = ref('All runs')
const limit = ref(20)
const count = ref(10)
const selectedResult = ref<Result>()
const messages = ref<Message[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const older = ref(false)
const offset = ref(0)
const turns = computed(() => conversationTurns(messages.value, false))
let historyGeneration = 0
function closeDetails() { historyGeneration++; selectedResult.value = undefined; messages.value = []; historyLoading.value = false; historyError.value = ''; older.value = false }
async function readDetails(result: Result, append = false) {
  if (!props.active || !props.connected || historyLoading.value || result.run.source === 'cron_output' || result.run.id.startsWith('cron_output:')) return
  const scope = generation, request = ++historyGeneration, owner = result.run.profile || profile.value
  if (!append) { messages.value = []; offset.value = 0 }
  selectedResult.value = result; historyLoading.value = true; historyError.value = ''
  const valid = () => current(scope) && request === historyGeneration
  try {
    const page = await read(valid, () => api.history(owner, result.run.id, offset.value))
    if (!page || !valid()) return
    messages.value = append ? mergeHistory(historyMessages(page), messages.value) : historyMessages(page)
    offset.value = page.pagination.offset + page.pagination.returned
    older.value = page.pagination.returned === page.pagination.limit
  } catch (value) { if (valid()) historyError.value = failure(value) }
  finally { if (valid()) historyLoading.value = false }
}
let generation = 0
let outputGeneration = 0
let timer: ReturnType<typeof setInterval> | undefined
const read = createResultReadQueue()
const pendingOutputs = new Set<string>()
const current = (scope: number) => scope === generation && props.active && props.connected
const filtered = computed(() => results.value.filter(result => (!props.jobId || result.job.id === props.jobId) && (status.value === 'All runs' || resultStatus(result.run) === status.value)))
const visible = computed(() => filtered.value.slice(0, count.value))
const date = (value?: number) => value == null ? 'Date unavailable' : new Date(value * 1000).toLocaleString()
const failure = (value: unknown) => value instanceof Error ? value.message : 'Results request failed.'
async function loadOutput(result: Result, scope = generation) {
  if (!current(scope) || result.run.source === 'cron_output' || result.run.id.startsWith('cron_output:')) return
  const outputScope = outputGeneration
  const valid = () => current(scope) && outputScope === outputGeneration
  const key = `${scope}:${outputScope}:${result.key}`
  if (pendingOutputs.has(key)) return
  pendingOutputs.add(key)
  result.error = undefined
  try {
    const owner = result.run.profile || profile.value
    const page = await read(() => valid() && visible.value.some(row => row.key === result.key), () => api.history(owner, result.run.id, 0))
    if (!page || !valid()) return
    result.output = resultOutput(page)
    result.signature = JSON.stringify([result.run.ended_at, result.run.message_count, result.run.output_tokens])
  } catch (value) { if (valid()) result.error = failure(value) }
  finally { pendingOutputs.delete(key) }
}
async function loadOutputs(scope: number) {
  await Promise.all(visible.value.filter(result => result.output === undefined && !result.error).map(result => loadOutput(result, scope)))
}
async function refresh() {
  if (!props.active || !props.connected || loading.value) return
  const scope = generation
  outputGeneration++
  loading.value = true; error.value = ''
  try {
    const requestedProfile = props.profile
    const owner = await read(() => current(scope), () => api.profile(requestedProfile))
    if (!owner || !current(scope)) return
    if (profile.value && profile.value !== owner) { results.value = []; jobs.value = []; closeDetails(); emit('jobs', []) }
    profile.value = owner
    const catalog = await read(() => current(scope), () => api.jobs(owner))
    if (!catalog || !current(scope)) return
    profile.value = owner; jobs.value = catalog; emit('jobs', catalog)
    const rows: Result[] = []
    for (const job of catalog) {
      try {
        const page = await read(() => current(scope), () => api.runs(owner, job.id, limit.value))
        if (!page || !current(scope)) return
        rows.push(...page.runs.map(run => ({ key: `${job.id}:${run.id}`, job, run })))
      } catch (value) { if (scope === generation) error.value += `${job.name || job.id}: ${failure(value)}\n` }
    }
    if (!current(scope)) return
    const cached = new Map(results.value.map(result => [result.key, result]))
    for (const row of rows) {
      const previous = cached.get(row.key)
      const signature = JSON.stringify([row.run.ended_at, row.run.message_count, row.run.output_tokens])
      if (resultStatus(row.run) === 'Finished' && previous?.signature === signature) { row.output = previous.output; row.signature = signature }
    }
    results.value = rows.sort((a, b) => (b.run.started_at || 0) - (a.run.started_at || 0))
    await loadOutputs(scope)
  } catch (value) { if (scope === generation) error.value = failure(value) }
  finally { if (scope === generation) loading.value = false }
}
watch(() => [props.active, props.connected, props.profile] as const, (values, previous) => {
  generation++; loading.value = false; clearInterval(timer); closeDetails()
  if (!previous || values[2] !== previous[2]) {
    results.value = []; jobs.value = []; profile.value = ''; error.value = ''; count.value = 10; limit.value = 20; status.value = 'All runs'; emit('jobs', [])
  }
  if (props.active && props.connected) {
    void refresh()
    timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15_000)
  }
}, { immediate: true })
watch(() => [props.jobId, status.value], () => { count.value = 10; if (props.active && props.connected) void loadOutputs(generation) })
watch(count, () => { if (props.active && props.connected) void loadOutputs(generation) })
onBeforeUnmount(() => { generation++; clearInterval(timer) })
</script>

<template>
  <section class="results-view" aria-label="Results">
    <div class="results-width">
      <p class="results-description">Outputs from your scheduled jobs.</p>
      <div class="results-toolbar"><span class="muted">{{ profile ? `Profile: ${profile}` : '' }}</span><label>Show <select v-model="status" aria-label="Run status"><option>All runs</option><option>Running</option><option>Finished</option><option>Unknown</option></select></label><button :disabled="loading || !connected" @click="refresh">Refresh</button></div>
      <p class="results-limit">Showing up to {{ limit }} recent runs per job. Hermes does not provide older run pagination.</p>
      <p v-if="!connected" role="status">Connect to Hermes to load results.</p>
      <p v-if="loading" role="status">Loading results…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <article v-for="result in visible" :key="result.key" class="result-card">
        <header><div><h2>{{ result.job.name || result.job.id }}</h2><time>{{ date(result.run.started_at) }}</time></div><span class="result-status" :class="resultStatus(result.run).toLowerCase()">{{ resultStatus(result.run) }}</span></header>
        <div class="result-body">
        <div v-if="result.run.source === 'cron_output' || result.run.id.startsWith('cron_output:')" class="result-preview"><p class="muted">Output preview · Full output unavailable through the Hermes API</p><p>{{ result.run.preview || 'No output preview returned by Hermes.' }}</p></div>
        <div v-else-if="result.error" role="alert"><p>{{ result.error }}</p><button :disabled="!connected || !active" @click="loadOutput(result)">Retry output</button></div>
        <MarkdownMessage v-else-if="result.output" :text="result.output" :profile="result.run.profile || profile" />
        <p v-else class="muted">{{ result.output === undefined ? 'Loading output…' : 'No assistant output in the latest history page. Open the conversation to inspect older messages.' }}</p>
        </div>
        <footer><button v-if="result.run.source !== 'cron_output' && !result.run.id.startsWith('cron_output:')" :disabled="!connected" @click="readDetails(result)">View conversation</button><button :disabled="!connected" @click="$emit('manage', result.job.id)">Manage job</button></footer>
      </article>
      <button v-if="filtered.length > count" :disabled="loading || !connected" @click="count += 10">Load more results</button>
      <button v-if="limit < 100 && results.some(result => results.filter(row => row.job.id === result.job.id).length >= limit)" :disabled="loading || !connected" @click="limit = 100; refresh()">Show up to 100 runs per job</button>
      <p v-if="!loading && !error && !visible.length" class="muted">No matching results.</p>
    </div>
    <CronRunDialog v-if="selectedResult" :title="selectedResult.job.name || selectedResult.job.id" :date="date(selectedResult.run.started_at)" :refreshing="historyLoading" :connected="connected" @close="closeDetails" @refresh="readDetails(selectedResult)">
      <p v-if="historyLoading" role="status">Loading conversation…</p>
      <p v-if="historyError" role="alert">{{ historyError }}</p>
      <button v-if="older" :disabled="historyLoading || !connected" @click="readDetails(selectedResult, true)">Load older messages</button>
      <p v-if="!historyLoading && !historyError && !messages.length" class="muted">No messages returned by Hermes.</p>
      <ConversationTurn v-for="turn in turns" :key="turn.key" :turn="turn" :profile="selectedResult.run.profile || profile" :thinking="false" />
    </CronRunDialog>
  </section>
</template>

<style scoped>
.results-view { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 32px; }
.results-width { max-width: 1000px; margin: auto; }
.results-description { margin: 0 0 18px; font-size: 14px; color: var(--secondary-text); }
.results-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.results-toolbar > span { margin-right: auto; font-size: 12px; }
.results-toolbar label { font-size: 13px; }
.results-toolbar select { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 7px; }
.results-limit { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 18px 0 24px; }
.result-card { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); margin-bottom: 20px; overflow-wrap: anywhere; overflow: hidden; }
.result-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 22px; border-bottom: 1px solid var(--border); background: var(--panel); }
.result-card h2 { font-family: inherit; font-weight: 600; margin: 0 0 6px; font-size: 14px; }
.result-card time { font-size: 12px; color: var(--muted); }
.result-body { padding: 22px; line-height: 1.7; font-size: 15px; }
.result-body > .muted { margin: 0; font-size: 13px; }
.result-preview p { white-space: pre-wrap; margin: 0; }
.result-preview .muted { font-size: 12px; margin-bottom: 12px; }
.result-status { flex-shrink: 0; font-size: 11px; border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; color: var(--secondary-text); }
.result-status.running { color: #9974d3; background: #9974d314; border-color: #9974d355; }
.result-status.unknown { color: var(--muted); background: var(--panel); }
.result-card footer { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
.result-card footer button { background: transparent; border-color: transparent; font-size: 12px; color: var(--secondary-text); }
.result-card footer button:hover { background: var(--hover); }
@media(max-width: 760px) { .results-view { padding: 20px 16px; } .result-body { padding: 18px; } .result-card header { padding: 14px 18px; } }
</style>
