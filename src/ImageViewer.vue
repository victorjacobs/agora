<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
const props = defineProps<{ src: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
function download() {
  const mime = /^data:image\/([^;]+);/i.exec(props.src)?.[1]?.toLowerCase()
  const extension = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime === 'x-icon' ? 'ico' : mime || 'png'
  const link = document.createElement('a')
  link.href = props.src
  link.download = `image.${extension}`
  document.body.append(link)
  link.click()
  link.remove()
}
function close() { dialog.value?.close(); emit('close') }
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => { if (dialog.value?.open) dialog.value.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-viewer" aria-label="Enlarged image" @cancel.prevent="close" @click="$event.target === dialog && close()">
      <section class="image-viewer-content">
        <header><span>{{ alt || 'Image' }}</span><div class="image-viewer-actions"><button type="button" class="download-image" aria-label="Download image" title="Download image" @click="download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></svg></button><button type="button" aria-label="Close image" title="Close · Escape" autofocus @click="close">×</button></div></header>
        <img :src="src" :alt="alt" draggable="false">
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-viewer { width: min(1200px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); overflow: hidden; box-shadow: 0 16px 80px #0005; }
.image-viewer::backdrop { background: #000b; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; }
.image-viewer-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.download-image svg { width: 20px; height: 20px; vertical-align: middle; }
header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
button { padding: 0; width: 32px; height: 32px; flex-shrink: 0; border: 0; background: transparent; font-size: 26px; line-height: 1; }
.image-viewer img { display: block; width: 100%; height: min(80dvh, 900px); object-fit: contain; background: var(--panel); }
@media (max-width: 760px) { .image-viewer { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } header { padding: 6px 10px; } }
</style>
