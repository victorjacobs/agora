<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ServerRequest } from './hermes/types'

const props = defineProps<{ request: ServerRequest; disabled: boolean }>()
const emit = defineEmits<{ answer: [result: Record<string, unknown>] }>()
const secret = ref('')
const input = ref<HTMLInputElement>()
const submitted = ref(false)
const blocked = computed(() => props.disabled || submitted.value)

function clear() {
  secret.value = ''
  if (input.value) input.value.value = ''
}

watch(() => [props.request, props.request.id, props.request.method, props.request.params.session_id, props.request.params.gateway_session_id], () => {
  clear()
  submitted.value = false
}, { flush: 'sync' })
watch(() => props.disabled, disabled => { if (disabled) clear() }, { flush: 'sync' })
onBeforeUnmount(clear)

function answer(cancel = false) {
  if (blocked.value || !cancel && !secret.value) return
  const value = cancel ? '' : secret.value
  clear()
  submitted.value = true
  emit('answer', { value })
}
</script>

<template>
  <section class="request-card" aria-label="Sudo password request">
    <form @submit.prevent="answer()">
      <h3>Sudo password required</h3>
      <pre v-if="typeof request.params.command === 'string' && request.params.command">{{ request.params.command }}</pre>
      <p>Sent directly to Hermes for the terminal tool, not as a chat message. Agora does not save your password.</p>
      <label class="answer-label">Sudo password
        <input ref="input" v-model="secret" type="password" autocomplete="off" :disabled="blocked" spellcheck="false" autocapitalize="none" />
      </label>
      <div class="button-row">
        <button class="primary" type="submit" :disabled="blocked || !secret">Submit</button>
        <button type="button" :disabled="blocked" @click="answer(true)">Cancel</button>
      </div>
    </form>
  </section>
</template>
