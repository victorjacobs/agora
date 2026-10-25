import { afterEach, expect, it, vi } from 'vitest'
import { createDrawerGesture, edgeOpeningAllowed } from '../src/conversation-drawer'

let dispose = () => {}
afterEach(() => { dispose(); vi.restoreAllMocks() })
function touch(type: string, x: number, y = 200, count = 1) {
  const event = new Event(type, { cancelable: true })
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) })
  return event as TouchEvent
}
function setup() {
  let enabled = true, open = false
  const move = vi.fn(), settle = vi.fn((value: boolean) => { open = value })
  const gesture = createDrawerGesture({ enabled: () => enabled, open: () => open, width: () => 320, move, reveal: () => { open = true }, settle })
  dispose = gesture.dispose
  return { gesture, move, settle, disable: () => { enabled = false } }
}
it('leaves Safari history alone outside installed iOS and supports desktop-class iPad detection', () => {
  expect(edgeOpeningAllowed('iPhone', 5, false)).toBe(false)
  expect(edgeOpeningAllowed('iPhone', 5, true)).toBe(true)
  expect(edgeOpeningAllowed('Macintosh', 5, false)).toBe(false)
  expect(edgeOpeningAllowed('Macintosh', 0, false)).toBe(true)
  expect(edgeOpeningAllowed('Android', 5, false)).toBe(true)
})
it('ignores vertical, outside-edge, inactive and multi-touch starts without cancelling their defaults', () => {
  const { gesture, move, disable } = setup()
  gesture.start(touch('touchstart', 40), true)
  expect(window.dispatchEvent(touch('touchmove', 180))).toBe(true)
  gesture.start(touch('touchstart', 2), true)
  expect(window.dispatchEvent(touch('touchmove', 8, 260))).toBe(true)
  expect(window.dispatchEvent(touch('touchmove', 200, 260))).toBe(true)
  gesture.start(touch('touchstart', 2, 200, 2), true)
  expect(window.dispatchEvent(touch('touchmove', 200))).toBe(true)
  disable()
  gesture.start(touch('touchstart', 2), true)
  expect(window.dispatchEvent(touch('touchmove', 200))).toBe(true)
  expect(move).not.toHaveBeenCalled()
})
it('cancels to the initial state on native cancellation, second finger and context teardown', () => {
  const { gesture, settle } = setup()
  for (const type of ['touchcancel', 'pointercancel', 'blur']) {
    gesture.start(touch('touchstart', 2), true)
    expect(window.dispatchEvent(touch('touchmove', 200))).toBe(false)
    window.dispatchEvent(new Event(type))
    expect(settle).toHaveBeenLastCalledWith(false)
    expect(window.dispatchEvent(touch('touchmove', 250))).toBe(true)
  }
  gesture.start(touch('touchstart', 2), true)
  window.dispatchEvent(touch('touchmove', 200))
  window.dispatchEvent(touch('touchmove', 220, 200, 2))
  expect(settle).toHaveBeenLastCalledWith(false)
  gesture.start(touch('touchstart', 2), true)
  gesture.reset()
  expect(window.dispatchEvent(touch('touchmove', 200))).toBe(true)
})
it('rolls back short releases, blocks a drag click, and releases listeners on disposal', () => {
  const { gesture, settle } = setup()
  gesture.start(touch('touchstart', 2), true)
  window.dispatchEvent(touch('touchmove', 60))
  window.dispatchEvent(touch('touchend', 60, 200, 0))
  expect(settle).toHaveBeenLastCalledWith(false)
  expect(window.dispatchEvent(new MouseEvent('click', { cancelable: true }))).toBe(false)
  expect(window.dispatchEvent(new MouseEvent('click', { cancelable: true }))).toBe(true)
  gesture.start(touch('touchstart', 2), true)
  window.dispatchEvent(touch('touchmove', 200))
  gesture.dispose()
  expect(window.dispatchEvent(touch('touchmove', 250))).toBe(true)
})
it('follows a bounded edge drag and settles by distance, not a touch-down action', () => {
  const { gesture, move, settle } = setup()
  gesture.start(touch('touchstart', 2), true)
  expect(move).not.toHaveBeenCalled()
  window.dispatchEvent(touch('touchmove', 82))
  expect(move).toHaveBeenLastCalledWith(0.25, true)
  window.dispatchEvent(touch('touchmove', 260))
  window.dispatchEvent(touch('touchend', 260, 200, 0))
  expect(settle).toHaveBeenLastCalledWith(true)
  gesture.start(touch('touchstart', 250), false)
  window.dispatchEvent(touch('touchmove', 30))
  expect(move).toHaveBeenLastCalledWith(0.3125, true)
  window.dispatchEvent(touch('touchend', 30, 200, 0))
  expect(settle).toHaveBeenLastCalledWith(false)
})
