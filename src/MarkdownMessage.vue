<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { markdownImages, renderMarkdown } from './markdown'
import { loadImage } from './hermes/media'

const props = defineProps<{ text: string; profile?: string }>()
defineEmits<{ imageLoad: [] }>()
const images = reactive<Record<string, string>>({})
const failures = reactive<string[]>([])
const pending = new Set<string>()
let disposed = false
let generation = 0
const html = computed(() => renderMarkdown(props.text, images, failures))
watch(() => props.profile, () => {
  generation++
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

<template><div class="markdown" @load.capture="$emit('imageLoad')" v-html="html"></div></template>
