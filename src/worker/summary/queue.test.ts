import { describe, expect, it } from 'vitest'
import { drainSummaryQueue, enqueueSummary, hasQueuedSummary, SUMMARY_MAX_ATTEMPTS } from './queue'
import { summarySourceHash } from './service'
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
function fakeDb(
  rows: unknown[] = [],
  instance = { enabled: true, allowAutoGenerate: true },
  summary: { source_hash: string } | null = null,
) {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            run: async () => ({ success: true }),
            first: async () =>
              sql.includes('app_meta')
                ? { value: JSON.stringify(instance) }
                : sql.includes('note_summaries')
                  ? summary
                  : null,
            all: async () => ({ results: rows }),
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

const AUTO_ON = JSON.stringify({ aiSummary: { enabled: true, autoGenerate: true } })
const AUTO_OFF = JSON.stringify({ aiSummary: { enabled: true, autoGenerate: false } })

const SHANGHAI_NOON = Date.parse('2026-11-21T04:00:00Z') // 12:00 本地

describe('enqueueSummary', () => {
  it('merges repeat edits into one row and resets the attempt counter', async () => {
    const { db, statements } = fakeDb()
    await enqueueSummary(db, { userId: 'u1', noteId: 'n1', sourceHash: 'h1', settingsRaw: AUTO_ON })
    const insert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summary_queue'))!
    expect(insert.sql).toContain('ON CONFLICT(note_id) DO UPDATE')
    expect(insert.sql).toContain('attempts = 0')
    // available_at = 当前 + 静默期
    expect(insert.args[3]).toBe(insert.args[4] as number + SUMMARY_QUIET_MS)
  })

  it('skips enqueue when the user turned auto generation off', async () => {
    const { db, statements } = fakeDb()
    await enqueueSummary(db, { userId: 'u1', noteId: 'n1', sourceHash: 'h1', settingsRaw: AUTO_OFF })
    expect(statements.some((entry) => entry.sql.includes('INSERT INTO note_summary_queue'))).toBe(false)
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

  it('drops the task when the same body already has a summary', async () => {
    // 02:00 Asia/Shanghai，静默期已满：本可执行，但这份正文已有摘要。
    const night = Date.parse('2026-11-20T18:00:00Z')
    const title = 'Python 编译安装'
    const content = '正文内容'
    const hash = await summarySourceHash(title, content)
    const { db, statements } = fakeDb(
      [{
        note_id: 'n1',
        user_id: 'u1',
        source_hash: hash,
        attempts: 0,
        settings: JSON.stringify({
          aiSummary: { enabled: true, autoGenerate: true },
          appearance: { timezone: 'Asia/Shanghai' },
        }),
        title,
        content,
        updated_at: night - 10 * 3_600_000,
      }],
      { enabled: true, allowAutoGenerate: true },
      { source_hash: hash },
    )
    const processed = await drainSummaryQueue({ DB: db, AI: { run: async () => ({}) } } as unknown as Env, 5, night)
    expect(processed).toBe(0)
    expect(statements.some((entry) => entry.sql.includes("SET status = 'running'"))).toBe(false)
    expect(statements.some((entry) => entry.sql.includes('DELETE FROM note_summary_queue'))).toBe(true)
  })
})

describe('hasQueuedSummary', () => {
  function presenceDb(row: { present: number } | null) {
    const statements: Statement[] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            statements.push({ sql, args })
            return { first: async () => row }
          },
        }
      },
    } as unknown as D1Database
    return { db, statements }
  }

  it('只在待执行或执行中才算已排队', async () => {
    const { db, statements } = presenceDb({ present: 1 })
    expect(await hasQueuedSummary(db, 'u1', 'n1')).toBe(true)
    expect(statements[0]!.sql).toContain("status IN ('pending', 'running')")
    expect(statements[0]!.args).toEqual(['n1', 'u1'])
  })

  it('没有任务记录时返回 false，前端据此不再承诺今晚生成', async () => {
    const { db } = presenceDb(null)
    expect(await hasQueuedSummary(db, 'u1', 'n1')).toBe(false)
  })
})
