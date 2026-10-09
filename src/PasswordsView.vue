<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { loginDraft, loginValidation, type LoginMeta, type VaultApi, type VaultSource } from './hermes/vault'
import { ConnectionLost, RpcError } from './hermes/gateway'
const props = defineProps<{ active: boolean; connected: boolean; profile?: string; section: 'logins' | 'sources'; api: Pick<VaultApi, 'list' | 'sources' | 'add' | 'remove'> }>()
const items = ref<LoginMeta[]>([]), sources = ref<VaultSource[]>([])
const loading = ref(false), busy = ref(false), editing = ref(false), unsupported = ref(false), uncertain = ref(false)
const error = ref(''), notice = ref(''), query = ref('')
const draft = reactive(loginDraft())
const passwordInput = ref<HTMLInputElement>()
const removing = ref<LoginMeta>()
let generation = 0
const ready = computed(() => props.active && props.connected && !busy.value && !loading.value && !unsupported.value && !uncertain.value)
const filtered = computed(() => items.value.filter(item => `${item.label} ${item.origin} ${item.identifier} ${item.backend}`.toLowerCase().includes(query.value.toLowerCase())))
function clearForm() { if (passwordInput.value) passwordInput.value.value = ''; Object.assign(draft, loginDraft()); editing.value = false; removing.value = undefined }
function reset() { generation++; clearForm(); items.value = []; sources.value = []; query.value = ''; error.value = ''; notice.value = ''; unsupported.value = false; loading.value = false; busy.value = false; uncertain.value = false }
function failure(value: unknown, mutation = false) {
  if (value instanceof RpcError && value.code === -32601) { unsupported.value = true; return 'Passwords & Logins is unavailable on this Hermes version.' }
  if (mutation && value instanceof ConnectionLost) { uncertain.value = true; return 'The action may have reached Hermes. Refresh the login list and check it before trying again. It was not retried.' }
  return mutation ? 'Hermes could not complete the vault action. Refresh the list before trying again.' : 'Unable to read the vault. Check the connection and refresh.'
}
async function refresh() {
  if (!props.active || !props.connected || busy.value || loading.value) return
  const scope = generation, profile = props.profile
  loading.value = true; error.value = ''; unsupported.value = false
  try {
    const results = await Promise.allSettled([props.api.list(profile), props.api.sources(profile)])
    if (scope !== generation) return
    if (results[0].status === 'fulfilled') { items.value = results[0].value; uncertain.value = false } else error.value = failure(results[0].reason)
    if (results[1].status === 'fulfilled') sources.value = results[1].value
    else if (!error.value) error.value = 'Login sources are unavailable on this Hermes version or connection.'
  } finally { if (scope === generation) loading.value = false }
}
function addLogin() { if (ready.value) { clearForm(); error.value = ''; notice.value = ''; editing.value = true } }
async function mutate() {
  if (!ready.value) { clearForm(); return }
  if (editing.value) { const validation = loginValidation(draft); if (validation) { error.value = validation; return } }
  const scope = generation, profile = props.profile
  const adding = editing.value, removedId = removing.value?.id
  let addedId = ''
  busy.value = true; error.value = ''; notice.value = ''
  try {
    // Transport serializes synchronously; do not keep a second secret-bearing draft.
    const operation = editing.value ? props.api.add(profile, draft) : props.api.remove(profile, removing.value!)
    clearForm()
    const result = await operation
    if (adding && typeof result === 'string') addedId = result
    if (scope === generation) notice.value = result ? 'Action acknowledged by Hermes. Checking the login list…' : 'This login was already absent. Checking the login list…'
  } catch (value) { if (scope === generation) error.value = failure(value, true) }
  finally { if (scope === generation) { clearForm(); busy.value = false } }
  if (scope === generation && !error.value) {
    await refresh()
    if (scope === generation && !error.value) {
      const verified = adding ? items.value.some(item => item.backend === 'local' && item.id === addedId) : !items.value.some(item => item.backend === 'local' && item.id === removedId)
      notice.value = verified ? adding ? 'Login saved and verified in Hermes.' : 'Login removal verified in Hermes.' : ''
      if (!verified) error.value = 'Hermes acknowledged the action, but its effect is not visible in the refreshed list. Check before trying again.'
    }
  }
}
watch(() => [props.active, props.connected, props.profile] as const, ([active, connected, profile], previous) => {
  const sameWorkspace = previous?.[0] === active && previous?.[2] === profile
  const interrupted = sameWorkspace && (uncertain.value || !connected && busy.value)
  reset()
  if (interrupted) error.value = failure(new ConnectionLost(), true)
  if (active && connected && !uncertain.value) void refresh()
}, { immediate: true, flush: 'sync' })
watch(() => props.section, () => { clearForm(); query.value = '' })
onBeforeUnmount(reset)
</script>

<template>
  <section class="passwords-view" aria-label="Passwords & Logins">
    <div class="passwords-toolbar"><div><h2>{{ section === 'sources' ? 'Login sources' : 'Saved logins' }}</h2><p class="muted">{{ profile ? `Profile: ${profile}` : 'Server launch profile' }}</p></div><div class="button-row"><button :disabled="!active || !connected || busy || loading" @click="refresh">{{ loading ? 'Loading…' : 'Refresh' }}</button><button v-if="section === 'logins'" class="primary" :disabled="!ready" @click="addLogin">Add login</button></div></div>
    <p class="muted">Hermes owns the vault. Passwords are never revealed here. External managers are read-only; locked sources do not contribute logins.</p>
    <p v-if="!connected" role="status">Connect to Hermes to manage logins.</p>
    <p v-if="error" class="banner warning" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="editing" class="passwords-form request-card" autocomplete="off" @submit.prevent="mutate">
      <h3>Add login to Hermes vault</h3><p>Sent directly to the vault, not as a chat message. Bind this login to one exact website origin.</p>
      <label>Label<input v-model="draft.label" name="label" required :disabled="busy" autocomplete="off" /></label>
      <label>Website origin<input v-model="draft.origin" name="origin" required placeholder="https://example.com" :disabled="busy" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>
      <label>Identifier type<select v-model="draft.identifier_type" :disabled="busy"><option value="email">Email</option><option value="username">Username</option><option value="phone">Phone</option></select></label>
      <label>Username, email or phone<input v-model="draft.identifier" name="identifier" required :disabled="busy" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>
      <label>Password<input ref="passwordInput" v-model="draft.password" name="password" type="password" required :disabled="busy" autocomplete="new-password" /></label>
      <div class="button-row"><button type="button" @click="clearForm">Cancel</button><button class="primary" :disabled="!ready" type="submit">Save login</button></div>
    </form>
    <section v-if="removing" class="request-card" aria-label="Confirm login removal"><h3>Remove {{ removing.label }}?</h3><p>This deletes the login from the Hermes vault. It cannot be undone.</p><div class="button-row"><button @click="clearForm">Cancel</button><button class="danger" :disabled="!ready" @click="mutate">Remove login</button></div></section>
    <template v-if="section === 'logins'">
      <label class="passwords-search">Search login metadata<input v-model="query" type="search" autocomplete="off" placeholder="Label, website or identifier" /></label>
      <p v-if="!loading && !filtered.length && !unsupported" class="muted">{{ query ? 'No matching logins.' : 'No available logins. Add a login or check your sources.' }}</p>
      <article v-for="item in filtered" :key="`${item.backend}:${item.id}`" class="passwords-item"><div><h3>{{ item.label || 'Untitled login' }}</h3><p>{{ item.origin || 'No origin provided' }}</p><p>{{ item.identifier || 'No identifier provided' }}<span v-if="item.identifier_type"> · {{ item.identifier_type }}</span></p><p class="muted">{{ sources.find(source => source.name === item.backend)?.display_name || item.backend }}<span v-if="item.has_otp"> · 2FA configured</span><span v-if="item.backend !== 'local'"> · Read-only</span></p></div><button v-if="item.backend === 'local'" data-remove :disabled="!ready" @click="clearForm(); removing = item">Remove</button></article>
    </template>
    <template v-else><p v-if="!loading && !sources.length" class="muted">No source status available.</p><article v-for="source in sources" :key="source.name" class="passwords-item"><div><h3>{{ source.display_name }}</h3><p>{{ !source.installed ? 'Not installed' : !source.enabled ? 'Disabled' : source.needs_unlock && !source.unlocked ? 'Locked — logins are not listed' : 'Available' }}</p></div></article><p class="muted">Configure or unlock external managers in Hermes. This workspace does not change source settings.</p></template>
  </section>
</template>

<style scoped>
.passwords-view { overflow-y: auto; padding: 24px; flex: 1; min-height: 0; }
.passwords-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.passwords-toolbar h2, .passwords-item h3 { margin: 0; }
.passwords-toolbar h2 { font-size: 21px; font-weight: 550; }
.passwords-toolbar .button-row { margin-top: 0; }
.passwords-view .muted { padding: 0; }
.passwords-toolbar p { margin: 6px 0 0; }
.passwords-search, .passwords-form label { display: grid; gap: 6px; margin: 14px 0; }
.passwords-form { max-width: 640px; }
.passwords-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border); padding: 18px 0; }
.passwords-item div { min-width: 0; overflow-wrap: anywhere; }
.passwords-item h3 { font-size: 15px; font-weight: 600; }
.passwords-item p { margin: 6px 0 0; font-size: 14px; }
.passwords-item p.muted { font-size: 12px; }
.passwords-view button { min-height: 44px; }
@media (max-width: 700px) {
  .passwords-view { padding: 16px; }
  .passwords-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 12px; }
  .passwords-item div { display: contents; }
  .passwords-item h3 { grid-column: 1; grid-row: 1; overflow-wrap: anywhere; }
  .passwords-item button { grid-column: 2; grid-row: 1; }
  .passwords-item p { grid-column: 1 / -1; overflow-wrap: anywhere; }
}
@media (pointer: coarse) { .passwords-view input, .passwords-view select { font-size: 16px; min-height: 44px; } }
</style>
