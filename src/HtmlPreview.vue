<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fileReference } from './hermes/media'
import { buildPreviewDocument, loadPreview, PREVIEW_FRAME_POLICY, previewTheme } from './html-preview'

const props = defineProps<{ path: string; profile?: string }>()
const emit = defineEmits<{ resize: [] }>()
const file = computed(() => fileReference(props.path, props.profile))
const srcdoc = ref('')
const error = ref('')
const loading = ref(false)
const height = ref(320)
const inlineFrame = ref<HTMLIFrameElement>()
const expandedFrame = ref<HTMLIFrameElement>()
const dialog = ref<HTMLDialogElement>()
const expanded = ref(false)
const expandButton = ref<HTMLButtonElement>()
let controller: AbortController | undefined
let timeout: ReturnType<typeof setTimeout> | undefined
let generation = 0
let disposed = false

function close() {
  dialog.value?.close()
  expanded.value = false
  expandButton.value?.focus()
}
async function expand() {
  expanded.value = true
  await nextTick()
  dialog.value?.showModal()
}
function sendTheme() {
  const message = { type: 'agora-preview-theme', theme: previewTheme() }
  inlineFrame.value?.contentWindow?.postMessage(message, '*')
  expandedFrame.value?.contentWindow?.postMessage(message, '*')
}
function resized(event: MessageEvent) {
  if (event.source !== inlineFrame.value?.contentWindow || !inlineFrame.value) return
  if (event.data?.type !== 'agora-preview-size' || typeof event.data.height !== 'number' || !Number.isFinite(event.data.height)) return
  const next = Math.max(160, Math.min(720, Math.ceil(event.data.height)))
  if (next === height.value) return
  height.value = next
  emit('resize')
}
async function reload() {
  const current = ++generation
  controller?.abort()
  clearTimeout(timeout)
  controller = new AbortController()
  const active = controller
  srcdoc.value = ''
  error.value = ''
  loading.value = false
  close()
  height.value = 320
  const policy = document.querySelector<HTMLMetaElement>('meta#agora-preview-frame-policy[http-equiv="Content-Security-Policy"]')
  if (policy?.content !== PREVIEW_FRAME_POLICY) {
    error.value = 'Preview unavailable: required frame isolation policy is missing.'
    return
  }
  loading.value = true
  const timer = setTimeout(() => active.abort(), 15000)
  timeout = timer
  try {
    const html = await loadPreview(props.path, props.profile, active.signal)
    if (!disposed && current === generation) srcdoc.value = buildPreviewDocument(html, previewTheme())
  } catch (failure) {
    if (!disposed && current === generation) error.value = active.signal.aborted ? 'Preview timed out. Try again.' : failure instanceof Error ? failure.message : 'Preview unavailable.'
  } finally {
    clearTimeout(timer)
    if (!disposed && current === generation) { loading.value = false; emit('resize') }
  }
}
watch(() => [props.path, props.profile], reload, { immediate: true })
let appearance: MediaQueryList | undefined
let observer: MutationObserver | undefined
onMounted(() => {
  window.addEventListener('message', resized)
  appearance = window.matchMedia?.('(prefers-color-scheme: dark)')
  appearance?.addEventListener('change', sendTheme)
  observer = new MutationObserver(sendTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  controller?.abort()
  clearTimeout(timeout)
  window.removeEventListener('message', resized)
  appearance?.removeEventListener('change', sendTheme)
  observer?.disconnect()
  dialog.value?.close()
})
</script>

<template>
  <section class="html-preview" :aria-label="`HTML preview: ${file?.name || 'file'}`">
    <header>
      <span class="preview-name">{{ file?.name }}</span>
      <div class="preview-actions">
        <button v-if="srcdoc" ref="expandButton" type="button" :aria-label="`Expand ${file?.name}`" @click="expand">Expand</button>
        <a v-if="file" :href="file.url" :download="file.name" :aria-label="`Download ${file.name}`" rel="noopener noreferrer">Download</a>
      </div>
    </header>
    <p v-if="loading" role="status">Loading preview…</p>
    <div v-else-if="error" class="preview-error"><p role="status">{{ error }}</p><button type="button" :aria-label="`Retry ${file?.name}`" @click="reload">Retry</button></div>
    <iframe v-if="srcdoc" ref="inlineFrame" :title="`Preview of ${file?.name}`" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="srcdoc" :style="{ height: `${height}px` }" @load="sendTheme" />
    <footer>Isolated HTML · no external resources or chat actions</footer>
  </section>
  <Teleport to="body">
    <dialog v-if="expanded" ref="dialog" class="preview-dialog" :aria-label="`Expanded preview of ${file?.name}`" @cancel.prevent="close" @click="$event.target === dialog && close()">
      <header><span class="preview-name">{{ file?.name }}</span><div class="preview-actions"><a v-if="file" :href="file.url" :download="file.name" rel="noopener noreferrer">Download</a><button type="button" aria-label="Close preview" autofocus @click="close">Close</button></div></header>
      <iframe ref="expandedFrame" :title="`Expanded preview of ${file?.name}`" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="srcdoc" @load="sendTheme" />
    </dialog>
  </Teleport>
</template>

<style scoped>
.html-preview { min-width: 0; margin: 16px 0; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.preview-name { min-width: 0; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.preview-actions a, button { font-size: 12px; }
button { min-height: 36px; padding: 6px 10px; }
iframe { display: block; width: 100%; border: 0; background: var(--surface); }
p { margin: 12px; font-size: 13px; color: var(--muted); }
.preview-error { padding-bottom: 12px; }
.preview-error button { margin-left: 12px; }
footer { padding: 8px 12px; font-size: 10px; color: var(--muted); border-top: 1px solid var(--border); }
.preview-dialog { width: min(1200px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); overflow: hidden; box-shadow: 0 16px 80px #0005; }
.preview-dialog::backdrop { background: #000b; }
.preview-dialog iframe { height: min(80dvh, 900px); }
@media (max-width: 760px) { .preview-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } header { padding: 6px 10px; } }
</style>