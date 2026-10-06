import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import ImageAttachments from '../src/ImageAttachments.vue'
import type { ImageAttachment } from '../src/hermes/attachments'
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
function mount() {
  const props = reactive({ images: [] as ImageAttachment[], disabled: false, scope: 'a' })
  const busy = vi.fn()
  const added = vi.fn((image: ImageAttachment) => props.images.push(image))
  const component = ref<InstanceType<typeof ImageAttachments>>()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(ImageAttachments, { ...props, ref: component, onBusy: busy, onAdd: added, onRemove: id => { props.images = props.images.filter(image => image.id !== id) } }) })
  app.mount(host)
  cleanup = () => app.unmount()
  return { props, added, component, host, busy }
}
describe('image attachment composer controls', () => {
  it('accepts pasted and dropped images and lets users remove previews', async () => {
    const { component, added, host } = mount()
    const file = new File(['bytes'], 'clipboard.png', { type: 'image/png' })
    const paste = new Event('paste', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } })
    component.value!.paste(paste)
    expect(paste.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1))
    await nextTick()
    expect(host.querySelector('img')?.alt).toBe('clipboard.png')
    host.querySelector<HTMLButtonElement>('.attachment-preview button')!.click()
    await nextTick()
    expect(host.querySelector('img')).toBeNull()
    const drop = new Event('drop', { cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    component.value!.drop(drop)
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(2))
  })
  it('discards delayed image reads when the conversation scope changes', async () => {
    const { props, component, added, busy } = mount()
    const paste = new Event('paste', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['bytes'], 'image.png', { type: 'image/png' })] } })
    component.value!.paste(paste)
    props.scope = 'b'
    await nextTick()
    await vi.waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
    expect(added).not.toHaveBeenCalled()
  })
})
