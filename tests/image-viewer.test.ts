import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ImageViewer from '../src/ImageViewer.vue'

let cleanup = () => {}
afterEach(() => {
  cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it('offers image-only zoom and a reset without moving the viewer controls', async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true } },
    close: { configurable: true, value() { this.open = false } },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(ImageViewer, { src: 'data:image/png;base64,AA==', alt: 'Test image' }) })
  app.mount(host)
  cleanup = () => app.unmount()
  await nextTick()

  const image = document.querySelector<HTMLImageElement>('.image-viewer img')!
  const header = document.querySelector<HTMLElement>('.image-viewer header')!
  const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
  expect(zoomIn).not.toBeNull()
  zoomIn.click()
  await vi.waitFor(() => expect(image.style.transform).toContain('scale('))
  expect(image.style.transform).not.toContain('scale(1)')
  expect(header.style.transform).toBe('')
  document.querySelector<HTMLButtonElement>('[aria-label="Reset image zoom"]')!.click()
  await vi.waitFor(() => expect(image.style.transform).toContain('scale(1)'))
})
