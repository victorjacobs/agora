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
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <div class="markdown" @load.capture="$emit('imageLoad')" @click="openImage($event); openIosFirefoxLink($event)" @keydown="openImage" v-html="html"></div>
  <ImageViewer v-if="viewing" :src="viewing.src" :alt="viewing.alt" @close="viewing = undefined" />
</template>

<style scoped>
.markdown :deep(.media-file) { display: flex; align-items: center; gap: 12px; width: fit-content; max-width: 100%; margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); }
.markdown :deep(.media-file-name) { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.markdown :deep(.media-file a) { flex-shrink: 0; font-size: 12px; }
</style>
