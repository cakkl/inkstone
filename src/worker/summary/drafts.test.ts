import { describe, expect, it } from 'vitest'
import { acceptDraft, listVersions, loadDraft, restoreVersion, saveDraft } from './drafts'
import type { SummaryRow } from './service'

interface Statement {
  sql: string
  args: unknown[]
}

/**
 * 记录 SQL 的 D1 stub。`first` 按查询内容返回预置行，
 * 足以验证「草稿覆盖前先存历史」这类顺序与绑定值。
 */
function fakeDb(options: { draft?: Record<string, unknown> | null; summary?: SummaryRow | null; version?: Record<string, unknown> | null } = {}) {
  const statements: Statement[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args })
          return {
            run: async () => ({ success: true }),
            first: async () => {
              if (sql.includes('FROM note_summary_drafts')) return options.draft ?? null
              if (sql.includes('FROM note_summaries')) return options.summary ?? null
              if (sql.includes('FROM note_summary_versions')) return options.version ?? null
              return null
            },
            all: async () => ({ results: [] }),
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

const summaryRow: SummaryRow = {
  note_id: 'n1',
  summary_text: '旧摘要',
  summary_origin: 'user',
  summary_status: 'current',
  summary_language: 'zh-CN',
  source_hash: 'old-hash',
  model: 'm',
  generated_at: 1,
  updated_at: 2,
}

describe('summary drafts', () => {
  it('keeps only one draft per note by upserting', async () => {
    const { db, statements } = fakeDb()
    await saveDraft(db, {
      userId: 'u1',
      noteId: 'n1',
      text: '草稿内容',
      operation: 'update',
      sourceHash: 'h1',
      baseUpdatedAt: 10,
      model: 'm',
      promptVersion: 'summary-v1',
    })
    const insert = statements[0]!
    expect(insert.sql).toContain('ON CONFLICT(note_id) DO UPDATE')
    expect(insert.args[0]).toBe('n1')
    expect(insert.args[2]).toBe('草稿内容')
  })

  it('archives the current summary before accepting a draft', async () => {
    const { db, statements } = fakeDb({
      draft: { note_id: 'n1', draft_text: '新摘要', operation: 'update', base_updated_at: 2, model: 'm', created_at: 5 },
      summary: summaryRow,
    })
    const result = await acceptDraft({ db, userId: 'u1', noteId: 'n1', currentSourceHash: 'new-hash' })
    expect(result).toEqual({ ok: true })

    const versionInsert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summary_versions'))
    expect(versionInsert?.args[3]).toBe('旧摘要')
    expect(versionInsert?.args[7]).toBe('accept:update')

    const summaryInsert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summaries'))
    expect(summaryInsert?.args[2]).toBe('新摘要')
    // 用户改过的摘要接受草稿后仍标记为 user，避免再次被自动覆盖
    expect(summaryInsert?.args[3]).toBe('user')
    expect(summaryInsert?.args[5]).toBe('new-hash')

    expect(statements.some((entry) => entry.sql.includes('DELETE FROM note_summary_drafts'))).toBe(true)
  })

  it('reports a missing draft instead of writing anything', async () => {
    const { db, statements } = fakeDb({ draft: null })
    const result = await acceptDraft({ db, userId: 'u1', noteId: 'n1', currentSourceHash: 'h' })
    expect(result).toEqual({ ok: false, reason: 'missing_draft' })
    expect(statements.some((entry) => entry.sql.includes('INSERT INTO note_summaries'))).toBe(false)
  })

  it('restores a version and archives the current summary first', async () => {
    const { db, statements } = fakeDb({
      version: { id: 'v1', summary_text: '更早的摘要', summary_origin: 'ai', summary_language: 'zh-CN', source_hash: 'h0', operation: 'generate', created_at: 1 },
      summary: summaryRow,
    })
    const result = await restoreVersion({ db, userId: 'u1', noteId: 'n1', versionId: 'v1', currentSourceHash: 'h2', language: 'zh-CN' })
    expect(result).toEqual({ ok: true })

    const versionInsert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summary_versions'))
    expect(versionInsert?.args[7]).toBe('restore')
    const summaryInsert = statements.find((entry) => entry.sql.includes('INSERT INTO note_summaries'))
    expect(summaryInsert?.args[2]).toBe('更早的摘要')
  })

  it('returns null when the version does not belong to the note', async () => {
    const { db } = fakeDb({ version: null })
    const result = await restoreVersion({ db, userId: 'u1', noteId: 'n1', versionId: 'nope', currentSourceHash: 'h', language: 'zh-CN' })
    expect(result).toEqual({ ok: false, reason: 'missing_version' })
  })

  it('filters drafts and versions by user', async () => {
    const { db, statements } = fakeDb({ draft: null })
    await loadDraft(db, 'u1', 'n1')
    await listVersions(db, 'u1', 'n1')
    for (const statement of statements) {
      expect(statement.args).toContain('u1')
    }
  })
})
