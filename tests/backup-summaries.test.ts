import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  MARKDOWN_BACKUP_FORMAT,
  MARKDOWN_BACKUP_VERSION,
  parseMarkdownBackupManifest,
} from '../src/shared/backup-format'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { buildJsonExport } from '../src/worker/backup/snapshot'
import type { Env } from '../src/worker/env'

const noteId = 'a'.repeat(26)
const hash = 'b'.repeat(64)

const base = {
  format: MARKDOWN_BACKUP_FORMAT,
  version: MARKDOWN_BACKUP_VERSION,
  appVersion: '1.0.0',
  createdAt: '2026-11-22T00:00:00.000Z',
  snapshot: '20261122-000000-000',
  notes: [
    {
      id: noteId,
      path: `notes/测试--${noteId.slice(-8)}.md`,
      title: '测试',
      folder: [],
      attachmentHashes: [],
      state: 'notes' as const,
      archived: false,
      bytes: 10,
      sha256: hash,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    },
  ],
  attachments: [],
}

const summary = {
  noteId,
  text: '一份摘要。',
  origin: 'ai' as const,
  language: 'zh-CN',
  model: 'demo-model',
  evolved: true,
  refineCount: 2,
  sourceHash: hash,
  generatedAt: 3,
  updatedAt: 4,
}

describe('backup manifest summaries', () => {
  it('accepts a manifest without summaries (old backups)', () => {
    const parsed = parseMarkdownBackupManifest({ ...base })
    expect(parsed).not.toBeNull()
    expect(parsed?.summaries).toBeUndefined()
  })

  it('keeps valid summaries', () => {
    const parsed = parseMarkdownBackupManifest({ ...base, summaries: [summary] })
    expect(parsed?.summaries).toEqual([summary])
  })

  it('rejects a summary for a note outside the backup', () => {
    const parsed = parseMarkdownBackupManifest({
      ...base,
      summaries: [{ ...summary, noteId: 'c'.repeat(26) }],
    })
    expect(parsed).toBeNull()
  })

  it('rejects oversized summary text', () => {
    const parsed = parseMarkdownBackupManifest({
      ...base,
      summaries: [{ ...summary, text: 'x'.repeat(LIMITS.aiSummaryMaxChars + 1) }],
    })
    expect(parsed).toBeNull()
  })

  it('rejects duplicate summaries for the same note', () => {
    const parsed = parseMarkdownBackupManifest({
      ...base,
      summaries: [summary, summary],
    })
    expect(parsed).toBeNull()
  })
})

describe('buildJsonExport summaries', () => {
  it('writes summaries into the structured export', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
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
         VALUES (?, 'u1', '测试', '测试', '正文', '', 1, 1, 1, 0, 0, 0, 0, 'h', 1, 2)`,
      )
      .run(noteId)
    sqlite
      .prepare(
        `INSERT INTO note_summaries (note_id, user_id, summary_text, summary_origin, summary_language,
                                     source_hash, summary_status, model, generated_at, updated_at,
                                     summary_evolved, refine_count)
         VALUES (?, 'u1', '导出摘要', 'user', 'zh-CN', ?, 'current', NULL, 3, 4, 1, 2)`,
      )
      .run(noteId, hash)

    const db = {
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
      async batch(list: { all: () => Promise<unknown> }[]) {
        return Promise.all(list.map((statement) => statement.all()))
      },
    } as unknown as D1Database

    const bytes = await buildJsonExport({ DB: db } as unknown as Env, 'u1')
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    expect(parsed.notes).toHaveLength(1)
    expect(parsed.summaries).toHaveLength(1)
    expect(parsed.summaries[0]).toMatchObject({
      noteId,
      text: '导出摘要',
      origin: 'user',
      evolved: true,
      refineCount: 2,
    })
  })
})
