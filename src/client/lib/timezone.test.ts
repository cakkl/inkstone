import { describe, expect, it } from 'vitest'
import { shouldUpdateTimezone } from './timezone'

describe('timezone adoption', () => {
  it('writes when the stored value is missing', () => {
    expect(shouldUpdateTimezone('', 'Asia/Shanghai')).toBe(true)
    expect(shouldUpdateTimezone(null, 'Asia/Shanghai')).toBe(true)
  })

  it('writes when the user moved to another timezone', () => {
    expect(shouldUpdateTimezone('Asia/Shanghai', 'Europe/Berlin')).toBe(true)
  })

  it('stays quiet when nothing changed', () => {
    expect(shouldUpdateTimezone('Asia/Shanghai', 'Asia/Shanghai')).toBe(false)
  })

  it('never writes an empty detection', () => {
    expect(shouldUpdateTimezone('Asia/Shanghai', '')).toBe(false)
    expect(shouldUpdateTimezone('', '')).toBe(false)
  })
})
