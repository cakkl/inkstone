import { describe, expect, it } from 'vitest'
import { loadNoteSummaryBundles } from './sync-rows'

interface Statement {
  sql: string
  args: unknown[]
}

/** 记录每个语句的参数个数：D1 单个查询最多 99 个绑定参数（含 userId）。 */
function fakeDb() {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            all: async () => ({
              results: args
                .slice(1)
                .filter((value): value is string => typeof value === 'string' && value.startsWith('n'))
                .map((noteId) => ({
                  note_id: noteId,
                  summary_text: `摘要 ${noteId}`,
                  summary_origin: 'ai',
                  summary_status: 'current',
                  updated_at: 1,
                  summary_enabled: null,
                  auto_mode: 'inherit',
                  auto_generate: null,
                })),
            }),
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

describe('loadNoteSummaryBundles', () => {
  it('大批量笔记分块查询，任何一条都不超过 D1 的参数上限', async () => {
    // 全量同步一次最多 500 篇；旧实现把 500 个 ID 一次拼进 IN，501 个参数必然报错。
    const noteIds = Array.from({ length: 500 }, (_, index) => `n${index}`)
    const { db, statements } = fakeDb()

    const bundles = await loadNoteSummaryBundles(db, 'u1', noteIds)

    expect(statements.length).toBeGreaterThan(0)
    for (const entry of statements) {
      expect(entry.args.length).toBeLessThanOrEqual(99)
    }
    // 500 / 80 = 7 块，摘要与设置各 7 次查询。
    expect(statements.length).toBe(14)
    expect(bundles.size).toBe(500)
    expect(bundles.get('n0')?.summary?.text).toBe('摘要 n0')
    expect(bundles.get('n499')?.summary?.text).toBe('摘要 n499')
  })

  it('分块边界上的笔记都取得到摘要', async () => {
    const noteIds = Array.from({ length: 81 }, (_, index) => `n${index}`)
    const { db } = fakeDb()
    const bundles = await loadNoteSummaryBundles(db, 'u1', noteIds)
    // 第 81 条属于第二块。
    expect(bundles.get('n79')?.summary).not.toBeNull()
    expect(bundles.get('n80')?.summary).not.toBeNull()
  })

  it('没有笔记时不发查询', async () => {
    const { db, statements } = fakeDb()
    const bundles = await loadNoteSummaryBundles(db, 'u1', [])
    expect(statements).toEqual([])
    expect(bundles.size).toBe(0)
  })
})
