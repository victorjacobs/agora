<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string; date: string; refreshing: boolean; connected: boolean }>()
const emit = defineEmits<{ close: []; refresh: [] }>()
const dialog = ref<HTMLDialogElement>()
function close() { dialog.value?.close(); emit('close') }
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => { if (dialog.value?.open) dialog.value.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="cron-run-dialog" aria-label="Run conversation" @cancel.prevent="close" @click="$event.target === dialog && close()">
      <header>
        <div class="run-heading"><h2>{{ title }}</h2><p>{{ date }} · Read-only conversation</p></div>
        <div class="run-actions"><button :disabled="refreshing || !connected" @click="$emit('refresh')">Refresh run</button><button autofocus @click="close">Close</button></div>
      </header>
      <div class="run-messages" tabindex="0" aria-label="Run messages"><slot /></div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.cron-run-dialog { width: min(1000px, calc(100vw - 48px)); max-width: none; height: min(850px, calc(100dvh - 48px)); max-height: none; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: 0 16px 80px #0005; overflow: hidden; }
.cron-run-dialog[open] { display: flex; flex-direction: column; }
.cron-run-dialog::backdrop { background: #0009; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.run-heading { min-width: 0; }
h2 { margin: 0; font-family: inherit; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
p { margin: 7px 0 0; font-size: 12px; color: var(--muted); }
.run-actions { display: flex; gap: 8px; flex-shrink: 0; }
.run-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 24px; }
@media (max-width: 760px) { .cron-run-dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); } header { align-items: flex-start; flex-wrap: wrap; padding: 16px; } .run-messages { padding: 16px; } }
</style>
