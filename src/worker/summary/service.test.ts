import { describe, expect, it } from 'vitest'
import { generateSummary, REFINE_DRIFT_MAX, resolveMode, saveUserSummary, toAiSummary, type SummaryRow } from './service'
import type { SummaryProvider } from './provider'

interface Statement {
  sql: string
  args: unknown[]
}

/** 只记录 SQL 的最小 D1 stub：足够验证写入顺序与绑定值。 */
function fakeDb(options: { usageNeurons?: number } = {}) {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            run: async () => ({ success: true }),
            first: async () => {
              if (sql.includes('ai_summary_usage_daily')) {
                return { requests: 1, neurons: options.usageNeurons ?? 0 }
              }
              return null
            },
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

function providerReturning(overrides: Partial<Awaited<ReturnType<SummaryProvider['generate']>>> = {}): SummaryProvider {
  return {
    async generate() {
      return {
        text: '这是一段测试摘要。',
        model: 'test-model',
        inputTokens: 100,
        outputTokens: 50,
        neurons: 12.5,
        truncated: false,
        ...overrides,
      }
    },
  }
}

const note = { id: 'n1', title: 'T', content: 'x'.repeat(200) }

describe('generateSummary', () => {
  it('stores the summary and records usage on success', async () => {
    const { db, statements } = fakeDb()
    const outcome = await generateSummary({ db, provider: providerReturning(), userId: 'u1', note, locale: 'zh-CN' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.target !== 'summary') throw new Error('expected a stored summary')
    expect(outcome.summary.origin).toBe('ai')
    expect(outcome.summary.status).toBe('current')
    expect(outcome.summary.text).toBe('这是一段测试摘要。')
    expect(outcome.neurons).toBe(12.5)

    const insert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summaries'))
    expect(insert).toBeDefined()
    expect(insert!.args[0]).toBe('n1')
    expect(insert!.args[2]).toBe('这是一段测试摘要。')
    expect(insert!.args[3]).toBe('zh-CN')
    // 全新生成：不带用户口径，也不累计补充次数。
    expect(insert!.args[8]).toBe(0)
    expect(insert!.args[9]).toBe(0)

    const usage = statements.filter((entry) => entry.sql.includes('ai_summary_usage_daily'))
    // 一次读、一次写。
    expect(usage.length).toBe(2)
  })

  it('writes a draft when the request explicitly asks for one', async () => {
    const { db, statements } = fakeDb()
    const outcome = await generateSummary({
      db,
      provider: providerReturning(),
      userId: 'u1',
      note,
      locale: 'zh-CN',
      asDraft: true,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.target !== 'draft') throw new Error('expected a draft')
    expect(outcome.draftText).toBe('这是一段测试摘要。')
    expect(statements.some((entry) => entry.sql.includes('INSERT INTO note_summaries'))).toBe(false)
    expect(statements.some((entry) => entry.sql.includes('INSERT INTO note_summary_drafts'))).toBe(true)
  })

  it('rejects a truncated response without writing a summary', async () => {
    const { db, statements } = fakeDb()
    const outcome = await generateSummary({
      db,
      provider: providerReturning({ truncated: true }),
      userId: 'u1',
      note,
      locale: 'zh-CN',
    })
    expect(outcome).toEqual({ ok: false, code: 'truncated' })
    expect(statements.some((entry) => entry.sql.includes('INSERT INTO note_summaries'))).toBe(false)
  })

  it('stops before calling the model when the daily quota is spent', async () => {
    const { db } = fakeDb({ usageNeurons: 8_000 })
    let called = false
    const provider: SummaryProvider = {
      async generate() {
        called = true
        throw new Error('should not run')
      },
    }
    const outcome = await generateSummary({ db, provider, userId: 'u1', note, locale: 'zh-CN' })
    expect(outcome).toEqual({ ok: false, code: 'quota_exhausted' })
    expect(called).toBe(false)
  })

  it('reports ai_unavailable when no provider is configured', async () => {
    const { db } = fakeDb()
    const outcome = await generateSummary({ db, provider: null, userId: 'u1', note, locale: 'zh-CN' })
    expect(outcome).toEqual({ ok: false, code: 'ai_unavailable' })
  })
})

describe('saveUserSummary', () => {
  it('marks the summary as user-authored', async () => {
    const { db, statements } = fakeDb()
    await saveUserSummary({ db, userId: 'u1', note, text: '手改的摘要', locale: 'zh-CN' })
    const insert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summaries'))
    expect(insert!.sql).toContain("'user'")
    expect(insert!.args[2]).toBe('手改的摘要')
    expect(insert!.args[3]).toBe('zh-CN')
  })
})

describe('toAiSummary', () => {
  const row: SummaryRow = {
    note_id: 'n1',
    summary_text: 'text',
    summary_origin: 'ai',
    summary_status: 'current',
    summary_language: 'zh-CN',
    source_hash: 'abc',
    model: 'm',
    generated_at: 1,
    updated_at: 2,
    summary_evolved: 0,
    refine_count: 0,
    last_fresh_at: null,
  }

  it('keeps current when the source hash matches', () => {
    expect(toAiSummary(row, 'abc').status).toBe('current')
  })

  it('treats a changed source hash as outdated even when the column says current', () => {
    expect(toAiSummary(row, 'def').status).toBe('outdated')
  })

  it('maps origin and language for the client', () => {
    const mapped = toAiSummary({ ...row, summary_origin: 'user' })
    expect(mapped.origin).toBe('user')
    expect(mapped.language).toBe('zh-CN')
  })
})

describe('resolveMode', () => {
  const base = {
    note_id: 'n1',
    summary_text: '旧摘要',
    summary_origin: 'ai',
    summary_status: 'current',
    summary_language: 'zh-CN',
    source_hash: 'h',
    model: 'm',
    generated_at: 1,
    updated_at: 2,
    summary_evolved: 1,
    refine_count: 1,
    last_fresh_at: 1_000,
  } satisfies SummaryRow

  it('starts fresh when there is no summary', () => {
    expect(resolveMode(undefined, null, 5_000)).toBe('fresh')
  })

  it('refines while the summary carries user lineage', () => {
    expect(resolveMode(undefined, base, 5_000)).toBe('refine')
  })

  it('rewrites when the summary never had user lineage', () => {
    expect(resolveMode(undefined, { ...base, summary_evolved: 0 }, 5_000)).toBe('fresh')
  })

  it('falls back to fresh after too many refines', () => {
    expect(resolveMode(undefined, { ...base, refine_count: REFINE_DRIFT_MAX }, 5_000)).toBe('fresh')
  })

  it('falls back to fresh when the last rewrite is old', () => {
    const stale = REFINE_DRIFT_MAX * 24 * 60 * 60 * 1000
    expect(resolveMode(undefined, base, base.last_fresh_at! + stale * 10)).toBe('fresh')
  })

  it('honours an explicit request', () => {
    expect(resolveMode('refine', { ...base, refine_count: 99 }, 5_000)).toBe('refine')
    expect(resolveMode('fresh', base, 5_000)).toBe('fresh')
  })
})
