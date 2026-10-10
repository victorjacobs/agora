<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import CommandApprovalCard from './CommandApprovalCard.vue'
import MemoryApprovalCard from './MemoryApprovalCard.vue'
import VaultRequestCard from './VaultRequestCard.vue'
import SudoRequestCard from './SudoRequestCard.vue'
import { isMemoryApproval } from './hermes/memory'
import type { Approval, ServerRequest } from './hermes/types'

const props = defineProps<{ request: ServerRequest; disabled: boolean; dashboardUrl?: string }>()
const emit = defineEmits<{ answer: [result: Record<string, unknown>] }>()
const answers = reactive<Record<string, string>>({})
const selected = reactive<Record<string, string[]>>({})
const approval = computed(() => props.request.params as Approval)
const questions = computed(() => props.request.params.questions || [])
watch(questions, values => {
  for (const question of values) {
    answers[question.qid] ??= ''
    selected[question.qid] ??= []
  }
}, { immediate: true })
const locked = (qid: string) => Object.prototype.hasOwnProperty.call(props.request.params.answers || {}, qid)
const complete = computed(() => questions.value.every(question => locked(question.qid) || answers[question.qid]?.trim() || selected[question.qid]?.length))

function submit() {
  const result: Record<string, string | null> = { ...props.request.params.answers }
  for (const question of questions.value) {
    if (!locked(question.qid)) result[question.qid] = answers[question.qid]?.trim() || selected[question.qid]?.join(', ') || null
  }
  emit('answer', { answers: result })
}
</script>

<template>
  <MemoryApprovalCard v-if="request.method === 'approval' && isMemoryApproval(approval)" :approval="approval" :disabled="disabled" @decide="emit('answer', { choice: $event })" />
  <CommandApprovalCard v-else-if="request.method === 'approval'" :approval="approval" :disabled="disabled" @decide="emit('answer', { choice: $event })" />
  <VaultRequestCard v-else-if="['vault.save_login', 'vault.unlock_prompt', 'vault.code'].includes(request.method)" :key="request.id" :request="request" :disabled="disabled" @answer="emit('answer', $event)" />
  <SudoRequestCard v-else-if="request.method === 'sudo'" :key="request.id" :request="request" :disabled="disabled" @answer="emit('answer', $event)" />
  <section v-else class="request-card" :aria-label="`${request.method} request`">
    <form v-if="request.method === 'clarify' && questions.length" @submit.prevent="submit">
      <h3>Hermes needs your input</h3>
      <fieldset v-for="question in questions" :key="question.qid" :disabled="disabled || locked(question.qid)">
        <legend>{{ question.question }}</legend>
        <p v-if="locked(question.qid)">Answered: {{ request.params.answers?.[question.qid] ?? 'Skipped' }}</p>
        <div v-else>
          <div v-if="question.multi_select && question.choices?.length" class="choice-list">
            <label v-for="choice in question.choices" :key="choice">
              <input v-model="selected[question.qid]" type="checkbox" :value="choice" /> {{ choice }}
            </label>
          </div>
          <select v-else-if="question.choices?.length" v-model="answers[question.qid]" :aria-label="question.question">
            <option value="">Choose an answer</option>
            <option v-for="choice in question.choices" :key="choice" :value="choice">{{ choice }}</option>
          </select>
          <label class="answer-label">{{ question.choices?.length ? 'Or write an answer' : 'Your answer' }}
            <input v-model="answers[question.qid]" type="text" autocomplete="off" />
          </label>
        </div>
      </fieldset>
      <div class="button-row">
        <button class="primary" :disabled="disabled || !complete" type="submit">Send answers</button>
        <button :disabled="disabled" type="button" @click="emit('answer', {})">Skip questions</button>
      </div>
    </form>
    <template v-else>
      <h3>Unsupported request: {{ request.method }}</h3>
      <p>This request needs a compatible Hermes client. You can open the dashboard or stop the turn here.</p>
      <a :href="dashboardUrl || '/'" target="_blank" rel="noopener">Open Hermes dashboard ↗</a>
    </template>
  </section>
</template>
