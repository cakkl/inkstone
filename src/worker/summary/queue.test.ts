import { describe, expect, it } from 'vitest'
import { drainSummaryQueue, enqueueSummary, SUMMARY_MAX_ATTEMPTS } from './queue'
import { isSummaryDue, SUMMARY_QUIET_MS } from './quiet-window'
import type { Env } from '../env'

interface Statement {
  sql: string
  args: unknown[]
}

/**
 * 只记录 SQL 的最小 D1 stub：验证「保存后入队」的合并语义与出队时的筛选条件，
 * 不需要真实数据库或模型。
 */
function fakeDb(rows: unknown[] = []) {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            run: async () => ({ success: true }),
            first: async () => null,
            all: async () => ({ results: rows }),
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

const SHANGHAI_NOON = Date.parse('2026-11-21T04:00:00Z') // 12:00 本地

describe('enqueueSummary', () => {
  it('merges repeat edits into one row and resets the attempt counter', async () => {
    const { db, statements } = fakeDb()
    await enqueueSummary(db, { userId: 'u1', noteId: 'n1', sourceHash: 'h1' })
    const insert = statements[0]!
    expect(insert.sql).toContain('ON CONFLICT(note_id) DO UPDATE')
    expect(insert.sql).toContain('attempts = 0')
    // available_at = 当前 + 静默期
    expect(insert.args[3]).toBe(insert.args[4] as number + SUMMARY_QUIET_MS)
  })
})

describe('drainSummaryQueue', () => {
  it('does nothing without an AI binding', async () => {
    const { db } = fakeDb()
    const processed = await drainSummaryQueue({ DB: db } as unknown as Env, 5)
    expect(processed).toBe(0)
  })

  it('selects only pending tasks whose window has arrived', async () => {
    const { db, statements } = fakeDb([])
    await drainSummaryQueue({ DB: db, AI: { run: async () => ({}) } } as unknown as Env, 5, SHANGHAI_NOON)
    const select = statements[0]!
    expect(select.sql).toContain("q.status = 'pending'")
    expect(select.sql).toContain('q.available_at <= ?1')
    expect(select.sql).toContain('lease_until')
    expect(select.args[0]).toBe(SHANGHAI_NOON)
    expect(select.args[1]).toBe(5)
  })

  it('leaves the task for tomorrow when the paragraph is outside the night window', () => {
    // 白天 12:00 本地：即使静默期已满也不应执行
    expect(isSummaryDue({ now: SHANGHAI_NOON, lastEditAt: SHANGHAI_NOON - 10 * 3_600_000, timezone: 'Asia/Shanghai' })).toBe(false)
    // 凌晨 02:00 本地：静默期满即可执行
    const night = Date.parse('2026-11-20T18:00:00Z')
    expect(isSummaryDue({ now: night, lastEditAt: night - 10 * 3_600_000, timezone: 'Asia/Shanghai' })).toBe(true)
  })

  it('exposes a bounded retry count', () => {
    expect(SUMMARY_MAX_ATTEMPTS).toBeGreaterThan(1)
    expect(SUMMARY_MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})
