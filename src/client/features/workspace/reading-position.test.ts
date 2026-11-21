import { describe, expect, it } from 'vitest'
import { readingPositionKey, restoreReadingPosition } from './reading-position'

function scroller(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
  return { scrollHeight, clientHeight, scrollTop } as unknown as HTMLElement
}

describe('reading positions', () => {
  // 两种滚动容器的高度完全不同，共用一条键会把一边的像素坐标套到另一边。
  it('keeps editor and preview positions in separate keys', () => {
    expect(readingPositionKey('u1', 'n1', 'editor')).not.toBe(readingPositionKey('u1', 'n1', 'preview'))
    expect(readingPositionKey('u1', 'n1', 'editor')).toBe(readingPositionKey('u1', 'n1'))
  })

  it('restores the stored offset when the total height is comparable', () => {
    const target = scroller(2000, 500)
    restoreReadingPosition(target, { top: 600, max: 1500 })
    expect(target.scrollTop).toBe(600)
  })

  it('scales the offset when the total height changed a lot', () => {
    const target = scroller(4000, 500)
    restoreReadingPosition(target, { top: 500, max: 1000 })
    expect(target.scrollTop).toBe(1750)
  })

  it('clamps into range and ignores scrollers without overflow', () => {
    const target = scroller(1000, 500)
    restoreReadingPosition(target, { top: 999999, max: 500 })
    expect(target.scrollTop).toBe(500)
    const flat = scroller(400, 500)
    flat.scrollTop = 42
    restoreReadingPosition(flat, { top: 100, max: 0 })
    expect(flat.scrollTop).toBe(42)
  })
})
