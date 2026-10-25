export function edgeOpeningAllowed(userAgent: string, maxTouchPoints: number, standalone: boolean) {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  return !ios || standalone
}

interface DrawerGestureOptions {
  enabled: () => boolean
  open: () => boolean
  width: () => number
  move: (progress: number, dragging: boolean) => void
  reveal: () => void
  settle: (open: boolean) => void
}

export function createDrawerGesture(options: DrawerGestureOptions) {
  let active: { id: number; x: number; y: number; opening: boolean; claimed: boolean; progress: number } | undefined
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  function swallowClick(event: MouseEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
    clearClick()
  }
  function clearClick() {
    window.removeEventListener('click', swallowClick, true)
    window.removeEventListener('pointerdown', clearClick, true)
    window.removeEventListener('touchstart', clearClick, true)
    clearTimeout(clickTimer)
  }
  function detach() {
    window.removeEventListener('touchmove', move)
    window.removeEventListener('touchend', end)
    window.removeEventListener('touchcancel', cancel)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
  }
  function reset() { active = undefined; detach() }
  function finish(cancelled: boolean) {
    const current = active
    reset()
    if (!current?.claimed) return
    window.addEventListener('click', swallowClick, true)
    // A fresh user activation is not the compatibility click from this drag.
    window.addEventListener('pointerdown', clearClick, true)
    window.addEventListener('touchstart', clearClick, true)
    clickTimer = setTimeout(clearClick, 350)
    options.move(cancelled ? (current.opening ? 0 : 1) : current.progress, false)
    options.settle(cancelled ? !current.opening : current.progress >= 0.5)
  }
  function cancel() { finish(true) }
  function end() { finish(false) }
  function move(event: TouchEvent) {
    const current = active
    if (!current) return
    if (!options.enabled() || event.touches.length !== 1) { cancel(); return }
    const point = event.touches[0]!
    if (point.identifier !== current.id) { cancel(); return }
    const dx = point.clientX - current.x, dy = point.clientY - current.y
    if (!current.claimed) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
      if (Math.abs(dx) <= Math.abs(dy) * 1.3 || (current.opening ? dx <= 0 : dx >= 0)) { reset(); return }
      current.claimed = true
      if (current.opening) options.reveal()
    }
    // Only an admitted, horizontal single-touch sequence can cancel a default.
    if (event.cancelable) event.preventDefault()
    else { cancel(); return }
    current.progress = Math.max(0, Math.min(1, (current.opening ? 0 : 1) + dx / options.width()))
    options.move(current.progress, true)
  }
  function start(event: TouchEvent, opening: boolean) {
    if (active) { if (event.touches.length !== 1) cancel(); return }
    if (!options.enabled() || event.touches.length !== 1 || opening === options.open()) return
    const point = event.touches[0]!
    if (opening && (point.clientX < 0 || point.clientX > 20)) return
    active = { id: point.identifier, x: point.clientX, y: point.clientY, opening, claimed: false, progress: opening ? 0 : 1 }
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', cancel)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }
  return { start, reset, cancel, dispose() { reset(); clearClick() } }
}
