<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
defineProps<{ src: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
function close() { dialog.value?.close(); emit('close') }
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => { if (dialog.value?.open) dialog.value.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-viewer" aria-label="Enlarged image" @cancel.prevent="close" @click="$event.target === dialog && close()">
      <section class="image-viewer-content">
        <header><span>{{ alt || 'Image' }}</span><button type="button" aria-label="Close image" title="Close · Escape" autofocus @click="close">×</button></header>
        <img :src="src" :alt="alt" draggable="false">
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-viewer { width: min(1200px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); overflow: hidden; box-shadow: 0 16px 80px #0005; }
.image-viewer::backdrop { background: #000b; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; }
header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
button { padding: 0; width: 32px; height: 32px; flex-shrink: 0; border: 0; background: transparent; font-size: 26px; line-height: 1; }
.image-viewer img { display: block; width: 100%; height: min(80dvh, 900px); object-fit: contain; background: var(--panel); }
@media (max-width: 760px) { .image-viewer { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } header { padding: 6px 10px; } }
</style>
