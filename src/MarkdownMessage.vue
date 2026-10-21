<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { markdownImages, renderMarkdown } from './markdown'
import { openIosFirefoxLink } from './external-links'
import ImageViewer from './ImageViewer.vue'
import { imageSource, loadImage } from './hermes/media'

const props = defineProps<{ text: string; profile?: string }>()
defineEmits<{ imageLoad: [] }>()
const viewing = ref<{ src: string; alt: string }>()
function openImage(event: MouseEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
  const target = event.target
  if (!(target instanceof HTMLImageElement) || !imageSource(target.src)?.startsWith('data:')) return
  event.preventDefault()
  target.focus()
  viewing.value = { src: target.src, alt: target.alt }
}
const images = reactive<Record<string, string>>({})
const failures = reactive<string[]>([])
const pending = new Set<string>()
let disposed = false
let generation = 0
const html = computed(() => renderMarkdown(props.text, images, failures, props.profile))
const root = ref<HTMLElement>()
const copyTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
let copyGeneration = 0
function resetCopies() {
  copyGeneration++
  for (const timer of copyTimers.values()) clearTimeout(timer)
  copyTimers.clear()
}
watch(html, resetCopies, { flush: 'sync' })
watch([root, html], () => {
  for (const pre of root.value?.querySelectorAll('pre') || []) {
    if (!pre.querySelector('code') || pre.parentElement?.classList.contains('code-block')) continue
    const block = document.createElement('div')
    block.className = 'code-block'
    const toolbar = document.createElement('div')
    toolbar.className = 'code-toolbar'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    button.title = 'Copy code'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) icon.setAttribute(name, value)
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M9 9h11v11H9z M5 15H4V4h11v1')
    icon.append(path)
    const label = document.createElement('span')
    label.textContent = 'Copy code'
    label.setAttribute('aria-live', 'polite')
    button.append(icon, label)
    const status = document.createElement('span')
    status.className = 'code-copy-status'
    status.setAttribute('role', 'status')
    toolbar.append(button)
    pre.replaceWith(block)
    block.append(toolbar, pre, status)
  }
}, { flush: 'post' })
async function copyCode(event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button.code-copy') : null
  if (!button || !root.value?.contains(button) || button.disabled) return
  const block = button.closest('.code-block')!
  const code = block.querySelector('pre code')!
  const label = button.querySelector('span')!
  const status = block.querySelector('.code-copy-status')!
  const current = copyGeneration
  const active = () => !disposed && current === copyGeneration && root.value?.contains(button)
  event.preventDefault()
  clearTimeout(copyTimers.get(button))
  copyTimers.delete(button)
  status.textContent = ''
  label.textContent = 'Copy code'
  button.removeAttribute('data-copied')
  button.disabled = true
  try {
    await navigator.clipboard.writeText(code.textContent || '')
    if (!active()) return
    label.textContent = 'Copied'
    button.setAttribute('data-copied', '')
    copyTimers.set(button, setTimeout(() => {
      if (active()) { label.textContent = 'Copy code'; button.removeAttribute('data-copied') }
      copyTimers.delete(button)
    }, 2000))
  } catch {
    if (!active()) return
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(code)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    status.textContent = selection ? 'Copy failed. Code selected; copy it manually.' : 'Copy failed. Select the code and copy it manually.'
  } finally {
    if (active()) button.disabled = false
  }
}
watch(() => props.profile, () => {
  generation++
  viewing.value = undefined
  for (const source of Object.keys(images)) delete images[source]
  failures.splice(0)
  pending.clear()
}, { flush: 'sync' })
watch(() => [props.text, props.profile] as const, ([text, profile]) => {
  const current = generation
  for (const source of markdownImages(text)) {
    if (images[source] || pending.has(source) || failures.includes(source)) continue
    pending.add(source)
    void loadImage(source, undefined, profile).then(data => { if (!disposed && current === generation) images[source] = data })
      .catch(() => { if (!disposed && current === generation) failures.push(source) })
      .finally(() => { if (current === generation) pending.delete(source) })
  }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; resetCopies() })
</script>

<template>
  <div ref="root" class="markdown" @load.capture="$emit('imageLoad')" @click="copyCode($event); openImage($event); openIosFirefoxLink($event)" @keydown="openImage" v-html="html"></div>
  <ImageViewer v-if="viewing" :src="viewing.src" :alt="viewing.alt" @close="viewing = undefined" />
</template>

<style scoped>
.markdown :deep(.code-block) { position: relative; min-width: 0; min-height: 54px; margin: 1em 0; border: 1px solid var(--border); border-radius: 8px; background: var(--code); overflow: hidden; }
.markdown :deep(.code-block pre) { margin: 0 52px 0 0; border: 0; border-radius: 0; }
.markdown :deep(.code-toolbar) { position: absolute; top: 4px; right: 4px; }
.markdown :deep(.code-copy) { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0; font-size: 10px; background: transparent; border-color: transparent; }
.markdown :deep(.code-copy svg) { width: 16px; height: 16px; }
.markdown :deep(.code-copy:not([data-copied]) span) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.markdown :deep(.code-copy[data-copied] svg) { display: none; }
.markdown :deep(.code-copy:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
.markdown :deep(.code-copy-status) { display: block; margin: 4px 15px 12px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.markdown :deep(.code-copy-status:empty) { display: none; }
.markdown :deep(.media-file) { display: flex; align-items: center; gap: 12px; width: fit-content; max-width: 100%; margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); }
.markdown :deep(.media-file-name) { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.markdown :deep(.media-file a) { flex-shrink: 0; font-size: 12px; }
</style>
