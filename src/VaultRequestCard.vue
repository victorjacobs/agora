<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ServerRequest } from './hermes/types'

const props = defineProps<{ request: ServerRequest; disabled: boolean }>()
const emit = defineEmits<{ answer: [result: Record<string, unknown>] }>()
const identifier = ref('')
const secret = ref('')
const submitted = ref(false)
const saving = computed(() => props.request.method === 'vault.save_login')
const code = computed(() => props.request.method === 'vault.code')
const blocked = computed(() => props.disabled || submitted.value)

function clear() {
  identifier.value = ''
  secret.value = ''
}

watch(() => [props.request.id, props.request.method], () => { clear(); submitted.value = false })
watch(() => props.disabled, disabled => { if (disabled) clear() })

function answer(cancel = false) {
  if (blocked.value || !cancel && (!secret.value || saving.value && !identifier.value.trim())) return
  const value = cancel ? '' : saving.value ? JSON.stringify({ identifier: identifier.value.trim(), password: secret.value }) : secret.value
  clear()
  submitted.value = true
  emit('answer', { value })
}
</script>

<template>
  <section class="request-card" aria-label="Secure browser input">
    <form @submit.prevent="answer()">
      <h3 v-if="saving">Save a login for {{ request.params.site }}</h3>
      <h3 v-else-if="code">Verification code<span v-if="request.params.site"> for {{ request.params.site }}</span></h3>
      <h3 v-else>Unlock {{ request.params.display_name || request.params.backend }}</h3>
      <p v-if="saving">Website: <strong>{{ request.params.origin }}</strong></p>
      <p>Sent directly to Hermes, not as a chat message. The agent does not receive this secret.</p>
      <p v-if="saving">Hermes stores this login in its encrypted vault and binds it to this website.</p>
      <p v-else-if="code && request.params.hint">{{ request.params.hint }}</p>
      <p v-else-if="!code">Your master password unlocks the password manager for this session; it is not saved by Agora.</p>
      <label v-if="saving" class="answer-label">Username or email
        <input v-model="identifier" autocomplete="username" :disabled="blocked" spellcheck="false" autocapitalize="none" />
      </label>
      <label class="answer-label">{{ saving ? 'Password' : code ? 'Verification code' : 'Master password' }}
        <input v-model="secret" type="password" :autocomplete="code ? 'one-time-code' : saving ? 'new-password' : 'off'" :disabled="blocked" spellcheck="false" autocapitalize="none" />
      </label>
      <div class="button-row">
        <button class="primary" type="submit" :disabled="blocked || !secret || saving && !identifier.trim()">{{ saving ? 'Save and continue' : code ? 'Send code' : 'Unlock' }}</button>
        <button type="button" :disabled="blocked" @click="answer(true)">Cancel</button>
      </div>
    </form>
  </section>
</template>
