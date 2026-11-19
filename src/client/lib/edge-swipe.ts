import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEvent } from './hooks'
import { prefersReducedMotion } from './motion'

export const EDGE_SWIPE_WIDTH = 24
export const EDGE_SWIPE_MIN_DISTANCE_RATIO = 0.3
export const EDGE_SWIPE_MIN_VELOCITY = 0.35
const EDGE_SWIPE_DEAD_ZONE = 8
export const EDGE_SWIPE_EXIT_MS = 180

export function shouldCompleteSwipe(input: { distance: number; width: number; velocity: number }): boolean {
  return (
    input.distance >= Math.max(1, input.width) * EDGE_SWIPE_MIN_DISTANCE_RATIO ||
    input.velocity >= EDGE_SWIPE_MIN_VELOCITY
  )
}

interface SwipeState {
  pointerId: number
  startX: number
  startY: number
  distance: number
  lastX: number
  lastAt: number
  velocity: number
  dragging: boolean
}

export interface EdgeSwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface EdgeSwipeOptions {
  onDragChange?: (dragging: boolean) => void
  onDrag?: (distance: number, width: number) => void
  onDragEnd?: (commit: boolean) => void
}

function clearInlineTransform(element: HTMLElement): void {
  element.style.transition = ''
  element.style.transform = ''
}

function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId)
  } catch {
  }
}

function release(element: HTMLElement, pointerId: number): void {
  try {
    element.releasePointerCapture?.(pointerId)
  } catch {
  }
}

export function useEdgeSwipeBack(enabled: boolean, onBack: () => void, options: EdgeSwipeOptions = {}): EdgeSwipeHandlers {
  const back = useEvent(onBack)
  const dragChange = useEvent(options.onDragChange ?? (() => {}))
  const dragMove = useEvent(options.onDrag ?? (() => {}))
  const dragEnd = useEvent(options.onDragEnd ?? (() => {}))
  const swipe = useRef<SwipeState | null>(null)

  useEffect(() => {
    if (enabled) return
    if (swipe.current?.dragging) dragChange(false)
    swipe.current = null
  }, [enabled, dragChange])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.clientX > EDGE_SWIPE_WIDTH) return
    swipe.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      distance: 0,
      lastX: event.clientX,
      lastAt: event.timeStamp,
      velocity: 0,
      dragging: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = swipe.current
    if (!state || state.pointerId !== event.pointerId) return
    const element = event.currentTarget
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.dragging) {
      if (Math.abs(dx) < EDGE_SWIPE_DEAD_ZONE && Math.abs(dy) < EDGE_SWIPE_DEAD_ZONE) return
      if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) {
        swipe.current = null
        return
      }
      state.dragging = true
      element.style.transition = 'none'
      capture(element, event.pointerId)
      dragChange(true)
    }
    state.distance = Math.max(0, dx)
    const elapsed = event.timeStamp - state.lastAt
    if (elapsed > 0) state.velocity = (event.clientX - state.lastX) / elapsed
    state.lastX = event.clientX
    state.lastAt = event.timeStamp
    element.style.transform = `translateX(${state.distance}px)`
    dragMove(state.distance, element.clientWidth || window.innerWidth)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const state = swipe.current
    if (!state || state.pointerId !== event.pointerId) return
    swipe.current = null
    const element = event.currentTarget
    if (!state.dragging) return
    release(element, event.pointerId)
    const endDrag = () => dragChange(false)
    const width = element.clientWidth || window.innerWidth
    const commit = shouldCompleteSwipe({ distance: state.distance, width, velocity: state.velocity })
    dragEnd(commit)
    if (prefersReducedMotion()) {
      endDrag()
      if (commit) back()
      else clearInlineTransform(element)
      return
    }
    element.style.transition = `transform ${EDGE_SWIPE_EXIT_MS}ms var(--ease-out)`
    element.style.transform = commit ? 'translateX(100%)' : 'translateX(0px)'
    window.setTimeout(() => {
      endDrag()
      if (commit) back()
      else clearInlineTransform(element)
    }, EDGE_SWIPE_EXIT_MS)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const state = swipe.current
    if (!state) return
    swipe.current = null
    if (state.dragging) dragChange(false)
    clearInlineTransform(event.currentTarget)
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
