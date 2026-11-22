import { describe, expect, it } from 'vitest'
import {
  isSummaryDue,
  isSummaryStale,
  isWithinQuietWindow,
  localHour,
  nextAvailableAt,
  safeTimezone,
  SUMMARY_QUIET_MS,
} from './quiet-window'

const SHANGHAI = 'Asia/Shanghai'
/** 2026-11-21 01:30 北京时间 = 2026-11-20 17:30 UTC */
const at = (iso: string) => Date.parse(iso)

describe('quiet window', () => {
  it('falls back to UTC for unknown or malformed timezones', () => {
    expect(safeTimezone('')).toBe('UTC')
    expect(safeTimezone(null)).toBe('UTC')
    expect(safeTimezone('Not/AZone')).toBe('UTC')
    expect(safeTimezone(SHANGHAI)).toBe(SHANGHAI)
  })

  it('reads the hour in the user timezone', () => {
    expect(localHour(at('2026-11-20T17:30:00Z'), SHANGHAI)).toBe(1)
    expect(localHour(at('2026-11-20T17:30:00Z'), 'UTC')).toBe(17)
    // 午夜应返回 0 而不是 24
    expect(localHour(at('2026-11-20T16:00:00Z'), SHANGHAI)).toBe(0)
  })

  it('only accepts hours inside the night window', () => {
    expect(isWithinQuietWindow(at('2026-11-20T17:30:00Z'), SHANGHAI)).toBe(true) // 01:30
    expect(isWithinQuietWindow(at('2026-11-20T20:30:00Z'), SHANGHAI)).toBe(true) // 04:30
    expect(isWithinQuietWindow(at('2026-11-20T21:30:00Z'), SHANGHAI)).toBe(true) // 05:30 仍在窗口内
    expect(isWithinQuietWindow(at('2026-11-20T22:30:00Z'), SHANGHAI)).toBe(false) // 06:30 已出窗口
    expect(isWithinQuietWindow(at('2026-11-20T16:30:00Z'), SHANGHAI)).toBe(false) // 00:30 -> 未到
    expect(isWithinQuietWindow(at('2026-11-21T10:00:00Z'), SHANGHAI)).toBe(false) // 18:00
  })

  it('requires four quiet hours before the night window', () => {
    const now = at('2026-11-20T17:30:00Z') // 01:30 本地
    // 21:00 改完（12:00 UTC）→ 静默期到 01:00 本地，恰好可以
    expect(isSummaryDue({ now, lastEditAt: now - SUMMARY_QUIET_MS, timezone: SHANGHAI })).toBe(true)
    // 只静默了 3 小时 → 不行
    expect(isSummaryDue({ now, lastEditAt: now - SUMMARY_QUIET_MS + 3_600_000, timezone: SHANGHAI })).toBe(false)
  })

  it('does not run during the day even when the note is long idle', () => {
    const now = at('2026-11-21T10:00:00Z') // 18:00 本地
    expect(isSummaryDue({ now, lastEditAt: now - 48 * 3_600_000, timezone: SHANGHAI })).toBe(false)
  })

  it('defers a midnight edit to the next night', () => {
    // 03:00 本地还在改 → 静默期结束于 07:00，已出窗口
    const editedAt = at('2026-11-20T19:00:00Z')
    expect(isSummaryDue({ now: at('2026-11-20T20:00:00Z'), lastEditAt: editedAt, timezone: SHANGHAI })).toBe(false)
    // 次日 01:30 才对
    expect(isSummaryDue({ now: at('2026-11-21T17:30:00Z'), lastEditAt: editedAt, timezone: SHANGHAI })).toBe(true)
  })

  it('computes the earliest run time from the last edit', () => {
    expect(nextAvailableAt(1_000)).toBe(1_000 + SUMMARY_QUIET_MS)
  })

  it('treats jobs older than the max age as stale', () => {
    const now = at('2026-11-21T10:00:00Z')
    expect(isSummaryStale(now - 71 * 3_600_000, now)).toBe(false)
    expect(isSummaryStale(now - 73 * 3_600_000, now)).toBe(true)
  })
})
