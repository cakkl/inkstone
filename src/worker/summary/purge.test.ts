import { describe, expect, it } from 'vitest'
import { drainAiSummaryPurge, purgeAiSummary, purgeNoteSummary } from './purge'

interface Statement { sql: string; args: unknown[] }

function fakeDb(aiNotes: string[] = [], leftovers = { drafts: 0, queued: 0 }) {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () =>
              sql.includes('FROM note_summaries')
                ? { results: aiNotes.map((note_id) => ({ note_id })) }
                : { results: [] },
          }
        },
        run: async () => ({ meta: { changes: sql.includes('note_summary_drafts') ? leftovers.drafts : leftovers.queued } }),
      }
    },
    async batch(entries: { run?: unknown }[]) {
      void entries
      return []
    },
  } as unknown as D1Database
  return { db, statements }
}

describe('purge scope', () => {
  it('deletes everything for a single note', async () => {
    const { db, statements } = fakeDb()
    await purgeNoteSummary(db, 'u1', 'n1')
    const tables = statements.map((entry) => entry.sql)
    expect(tables.some((sql) => sql.includes('DELETE FROM note_summaries'))).toBe(true)
    expect(tables.some((sql) => sql.includes('DELETE FROM note_summary_versions'))).toBe(true)
    expect(tables.some((sql) => sql.includes('DELETE FROM note_summary_drafts'))).toBe(true)
    expect(tables.some((sql) => sql.includes('DELETE FROM note_summary_queue'))).toBe(true)
  })

  it('keeps hand-written summaries and history when AI is turned off', async () => {
    const { db, statements } = fakeDb()
    await purgeAiSummary(db, 'u1', 'n1')
    const summaryDelete = statements.find((entry) => entry.sql.includes('DELETE FROM note_summaries'))
    expect(summaryDelete?.sql).toContain("summary_origin = 'ai'")
    expect(statements.some((entry) => entry.sql.includes('note_summary_versions'))).toBe(false)
  })

  it('only removes rows older than the marker', async () => {
    const { db, statements } = fakeDb(['n1', 'n2'])
    const removed = await drainAiSummaryPurge(db, 'u1', 1_000)
    expect(removed).toBe(2)
    const select = statements[0]!
    expect(select.args).toEqual(['u1', 1_000, 200])
  })

  it('reports zero when nothing is left, so the marker can be cleared', async () => {
    const { db } = fakeDb([], { drafts: 0, queued: 0 })
    const removed = await drainAiSummaryPurge(db, 'u1', 1_000)
    expect(removed).toBe(0)
  })

  it('splits the delete so no query exceeds the D1 parameter limit', async () => {
    // D1 单个查询最多 99 个绑定参数（含 userId）；200 条一次拼进 IN 会超限。
    const ids = Array.from({ length: 200 }, (_, index) => `n${index}`)
    const { db, statements } = fakeDb(ids)
    const removed = await drainAiSummaryPurge(db, 'u1', 1_000)
    expect(removed).toBe(200)

    const deletes = statements.filter((entry) => entry.sql.includes('DELETE FROM note_summaries'))
    expect(deletes.length).toBe(3)
    for (const entry of deletes) {
      expect(entry.args.length).toBeLessThanOrEqual(99)
    }
    expect(deletes.map((entry) => entry.args.length)).toEqual([81, 81, 41])
  })
})
