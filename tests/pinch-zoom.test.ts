import { afterEach, expect, it } from 'vitest'
import { disablePinchZoom } from '../src/pinch-zoom'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined })

it('cancels pinch gestures without cancelling one-finger interactions', () => {
  dispose = disablePinchZoom(document)

  for (const type of ['gesturestart', 'gesturechange', 'touchstart', 'touchmove']) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    if (type.startsWith('touch')) Object.defineProperty(event, 'touches', { value: { length: 2 } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented, type).toBe(true)
  }

  for (const type of ['touchstart', 'touchmove', 'click']) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    if (type.startsWith('touch')) Object.defineProperty(event, 'touches', { value: { length: 1 } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented, type).toBe(false)
  }

  dispose()
  const event = new Event('gesturestart', { bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})
