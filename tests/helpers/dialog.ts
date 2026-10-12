import { afterAll, beforeAll } from 'vitest'

export function mockDialogs() {
  const methods = ['showModal', 'close'] as const
  const descriptors = methods.map(method => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method))
  beforeAll(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
    })
  })
  afterAll(() => {
    methods.forEach((method, index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    })
  })
}
