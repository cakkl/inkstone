import { describe, expect, it } from 'vitest'
import { remainingNeurons, utcDateKey } from './usage'

describe('summary usage', () => {
  it('formats the UTC day key', () => {
    expect(utcDateKey(Date.UTC(2026, 10, 21, 23, 30))).toBe('2026-11-21')
  })

  it('treats a zero limit as unlimited', () => {
    expect(remainingNeurons(12_345, 0)).toBe(-1)
  })

  it('never reports a negative remainder', () => {
    expect(remainingNeurons(9_999, 8_000)).toBe(0)
    expect(remainingNeurons(3_000, 8_000)).toBe(5_000)
  })
})
