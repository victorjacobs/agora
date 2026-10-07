export function disablePinchZoom(target: Document): () => void {
  const preventGesture = (event: Event) => { event.preventDefault() }
  const preventMultiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault()
  }

  // Safari gesture cancellation complements touch-action without blocking single-finger scrolling.
  target.addEventListener('gesturestart', preventGesture, { passive: false })
  target.addEventListener('gesturechange', preventGesture, { passive: false })
  target.addEventListener('touchstart', preventMultiTouch, { passive: false })
  target.addEventListener('touchmove', preventMultiTouch, { passive: false })

  return () => {
    target.removeEventListener('gesturestart', preventGesture)
    target.removeEventListener('gesturechange', preventGesture)
    target.removeEventListener('touchstart', preventMultiTouch)
    target.removeEventListener('touchmove', preventMultiTouch)
  }
}
