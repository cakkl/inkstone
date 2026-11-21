type ReadingPosition = { top: number; max: number }

/** 两个滚动容器的高度完全不同，像素值不能互相套用，必须各存一份。 */
export type ReadingSurface = 'editor' | 'preview'

export function readingPositionKey(userId: string, noteId: string, surface: ReadingSurface = 'editor'): string {
  return `inkstone:reading-position:${userId}:${noteId}:${surface}`
}

export function captureReadingPosition(scroller: HTMLElement): ReadingPosition {
  return {
    top: scroller.scrollTop,
    max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
  }
}

export function restoreReadingPosition(scroller: HTMLElement, position: ReadingPosition): void {
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  if (!max) return
  const top = position.max > 0 && Math.abs(max - position.max) > position.max * 0.2
    ? position.top / position.max * max
    : position.top
  scroller.scrollTop = Math.min(max, Math.max(0, top))
}

export function readReadingPosition(key: string): ReadingPosition | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const { top, max } = value as Record<string, unknown>
    return typeof top === 'number' && Number.isFinite(top) && top >= 0 &&
      typeof max === 'number' && Number.isFinite(max) && max >= 0
      ? { top, max } : null
  } catch {
    return null
  }
}

export function writeReadingPosition(key: string, position: ReadingPosition): void {
  try {
    localStorage.setItem(key, JSON.stringify(position))
  } catch {
    // Reading position is optional when browser storage is unavailable.
  }
}
