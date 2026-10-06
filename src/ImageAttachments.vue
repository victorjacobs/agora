<script setup lang="ts">
import { ref } from 'vue'
import { imageAccept, readAttachment, type ImageAttachment } from './hermes/attachments'
const props = defineProps<{ images: ImageAttachment[]; disabled: boolean; scope: string }>()
const emit = defineEmits<{ add: [image: ImageAttachment]; remove: [id: string]; error: [message: string]; busy: [value: boolean] }>()
const picker = ref<HTMLInputElement>()
const reading = ref(false)
async function add(files: File[]) {
  if (props.disabled || reading.value || !files.length) return
  const scope = props.scope
  reading.value = true
  emit('busy', true)
  try {
    for (const file of files) {
      if (scope !== props.scope) break
      if (props.images.length >= 8) throw new Error('Attach up to 8 images per message.')
      const image = await readAttachment(file)
      if (scope === props.scope) emit('add', image)
    }
  } catch (error) { if (scope === props.scope) emit('error', error instanceof Error ? error.message : 'Could not read image.') }
  finally { reading.value = false; emit('busy', false) }
}
function selected(event: Event) {
  const input = event.target as HTMLInputElement
  void add([...input.files || []])
  input.value = ''
}
function paste(event: ClipboardEvent) {
  const files = [...event.clipboardData?.files || []].filter(file => file.type.startsWith('image/'))
  if (files.length && !props.disabled) { event.preventDefault(); void add(files) }
}
function drop(event: DragEvent) {
  if (!event.dataTransfer?.files.length) return
  event.preventDefault()
  void add([...event.dataTransfer.files])
}
defineExpose({ paste, drop })
</script>

<template>
  <div v-if="images.length" class="attachment-previews">
    <div v-for="image in images" :key="image.id" class="attachment-preview">
      <img :src="image.dataUrl" :alt="image.name"><button type="button" :disabled="disabled || reading" :aria-label="'Remove ' + image.name" @click="emit('remove', image.id)">×</button>
    </div>
  </div>
  <input ref="picker" type="file" class="sr-only" :accept="imageAccept" multiple :disabled="disabled || reading" tabindex="-1" aria-label="Choose images" @change="selected">
  <button type="button" class="attach-image" :disabled="disabled || reading" title="Attach images" aria-label="Attach images" @click="picker?.click()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/><path d="m6 15 9-9"/></svg>
  </button>
</template>

<style scoped>
.attachment-previews { display: flex; gap: 8px; overflow-x: auto; padding: 0 0 12px; }
.attachment-preview { position: relative; flex-shrink: 0; }
.attachment-preview img { display: block; width: 76px; height: 76px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
.attachment-preview button { position: absolute; top: 3px; right: 3px; padding: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); font-size: 18px; }
.attach-image { position: absolute; bottom: 14px; left: 14px; padding: 6px; border: 0; background: transparent; color: var(--muted); }
.attach-image svg { display: block; width: 19px; height: 19px; }
</style>
