import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { restoreBackupSummaries } from '../src/worker/routes/transfer'
import { summarySourceHash } from '../src/worker/summary/service'
import type { MarkdownBackupManifest } from '../src/shared/backup-format'
import { MARKDOWN_BACKUP_FORMAT, MARKDOWN_BACKUP_VERSION } from '../src/shared/backup-format'

let sqlite: DatabaseSync
let db: D1Database

const userId = 'user-1'
const noteId = 'a'.repeat(26)
const hash = 'b'.repeat(64)

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  // 摘要表由迁移创建，这里按迁移 15/20 的最终结构补上。
  sqlite.exec(`CREATE TABLE note_summaries (
    note_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    summary_origin TEXT NOT NULL,
    summary_language TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    summary_status TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT,
    generated_at INTEGER,
    updated_at INTEGER NOT NULL,
    summary_evolved INTEGER NOT NULL DEFAULT 0,
    refine_count INTEGER NOT NULL DEFAULT 0,
    last_fresh_at INTEGER
  )`)
  sqlite
    .prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
                          is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
       VALUES (?, ?, '测试', '测试', '正文内容', '', 1, 1, 1, 0, 0, 0, 0, 'h', 1, 2)`,
    )
    .run(noteId, userId)
  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: unknown[] = []
      const args = () => [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return statement.get(...args() as never[]) ?? null },
        async all() { return { results: statement.all(...args() as never[]) } },
        async run() { return { meta: { changes: Number(statement.run(...args() as never[]).changes) } } },
      }
      return prepared
    },
  } as unknown as D1Database
})

const manifest = (summaries: NonNullable<MarkdownBackupManifest['summaries']>): MarkdownBackupManifest => ({
  format: MARKDOWN_BACKUP_FORMAT,
  version: MARKDOWN_BACKUP_VERSION,
  appVersion: '1.0.0',
  createdAt: '2026-11-22T00:00:00.000Z',
  snapshot: '20261122-000000-000',
  notes: [],
  attachments: [],
  summaries,
})

const ctx = { folderCache: new Map<string, string>(), result: {} as never, ftsEnabled: false }

describe('restoreBackupSummaries', () => {
  it('recomputes the source hash so a restored summary is not outdated', async () => {
    await restoreBackupSummaries(db, userId, manifest([{
      noteId,
      text: '恢复的摘要',
      origin: 'user',
      language: 'zh-CN',
      model: null,
      evolved: true,
      refineCount: 0,
      sourceHash: 'c'.repeat(64),
      generatedAt: 3,
      updatedAt: 4,
    }]), ctx)

    const row = sqlite
      .prepare('SELECT summary_text, summary_origin, source_hash, summary_evolved FROM note_summaries WHERE note_id = ?')
      .get(noteId) as { summary_text: string; summary_origin: string; source_hash: string; summary_evolved: number }
    expect(row.summary_text).toBe('恢复的摘要')
    expect(row.summary_origin).toBe('user')
    expect(row.summary_evolved).toBe(1)
    expect(row.source_hash).toBe(await summarySourceHash('测试', '正文内容'))
  })

  it('keeps an existing summary instead of overwriting it', async () => {
    sqlite
      .prepare(
        `INSERT INTO note_summaries (note_id, user_id, summary_text, summary_origin, summary_language,
                                     source_hash, summary_status, generated_at, updated_at)
         VALUES (?, ?, '本地摘要', 'user', 'zh-CN', ?, 'current', 1, 1)`,
      )
      .run(noteId, userId, hash)

    await restoreBackupSummaries(db, userId, manifest([{
      noteId,
      text: '备份里的摘要',
      origin: 'ai',
      language: 'zh-CN',
      model: null,
      evolved: false,
      refineCount: 0,
      sourceHash: 'd'.repeat(64),
      generatedAt: 3,
      updatedAt: 4,
    }]), ctx)

    const row = sqlite
      .prepare('SELECT summary_text FROM note_summaries WHERE note_id = ?')
      .get(noteId) as { summary_text: string }
    expect(row.summary_text).toBe('本地摘要')
  })
})
