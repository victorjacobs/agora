<script setup lang="ts">
import { computed } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import HtmlPreview from './HtmlPreview.vue'
import { previewParts } from './markdown'

const props = defineProps<{ text: string; profile?: string; allowPreviews?: boolean }>()
defineEmits<{ imageLoad: [] }>()
const parts = computed(() => props.allowPreviews ? previewParts(props.text) : [{ kind: 'markdown' as const, text: props.text, key: 'text-0' }])
</script>

<template>
  <template v-for="part in parts" :key="part.key">
    <HtmlPreview v-if="part.kind === 'preview'" :path="part.path" :profile="profile" @resize="$emit('imageLoad')" />
    <MarkdownContent v-else :text="part.text" :profile="profile" @image-load="$emit('imageLoad')" />
  </template>
</template>