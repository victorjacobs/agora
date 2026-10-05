<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { markdownImages, renderMarkdown } from './markdown'
import { loadImage } from './hermes/media'

const props = defineProps<{ text: string }>()
defineEmits<{ imageLoad: [] }>()
const images = reactive<Record<string, string>>({})
const failures = reactive<string[]>([])
const pending = new Set<string>()
let disposed = false
const html = computed(() => renderMarkdown(props.text, images, failures))
watch(() => props.text, text => {
  for (const source of markdownImages(text)) {
    if (images[source] || pending.has(source) || failures.includes(source)) continue
    pending.add(source)
    void loadImage(source).then(data => { if (!disposed) images[source] = data })
      .catch(() => { if (!disposed) failures.push(source) })
      .finally(() => pending.delete(source))
  }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true })
</script>

<template><div class="markdown" @load.capture="$emit('imageLoad')" v-html="html"></div></template>
