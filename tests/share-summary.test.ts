import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { shareRoutes } from '../src/worker/routes/share'

let sqlite: DatabaseSync
let db: D1Database

const noteId = 'a'.repeat(26)
const userId = 'user-1'
const slug = 'a'.repeat(20)

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.exec(`ALTER TABLE shares ADD COLUMN include_summary INTEGER NOT NULL DEFAULT 1`)
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
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
    VALUES ('user-1', 'admin', 'x', 'admin', 'Admin', '', 'owner', '{}', 1, 1)`)
  sqlite.exec(`INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
      is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
    VALUES ('${noteId}', 'user-1', '标题', '标题', '正文', '', 1, 1, 1, 0, 0, 0, 0, 'h', 1, 2)`)
  sqlite.exec(`INSERT INTO note_summaries (note_id, user_id, summary_text, summary_origin, summary_language,
      source_hash, summary_status, generated_at, updated_at)
    VALUES ('${noteId}', 'user-1', '分享摘要', 'user', 'zh-CN', 'h', 'current', 3, 4)`)

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

const createShare = (includeSummary: number) => {
  sqlite.exec(`INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at, include_summary)
    VALUES ('${slug}', '${noteId}', '${userId}', NULL, NULL, 0, 1, ${includeSummary})`)
}

const readPublic = async () => {
  const app = new Hono()
  app.onError((err, c) => c.json({ error: err.message }, 500))
  app.route('/api/public', shareRoutes)
  const res = await app.request(
    `http://localhost/api/public/${slug}`,
    { method: 'POST', body: '{}' },
    { DB: db, APP_NAME: 'Inkstone' } as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  )
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as { summary?: { text: string } | null } }
}

describe('public share summary', () => {
  it('returns the summary when the share includes it', async () => {
    createShare(1)
    const { status, body, text } = await readPublic()
    if (status !== 200) console.error('share error:', text)
    expect(status).toBe(200)
    expect(body.summary?.text).toBe('分享摘要')
  })

  it('omits the summary when the share disables it', async () => {
    createShare(0)
    const { body } = await readPublic()
    expect(body.summary).toBeNull()
  })

  it('returns null when the note has no summary', async () => {
    sqlite.exec(`DELETE FROM note_summaries`)
    createShare(1)
    const { body } = await readPublic()
    expect(body.summary).toBeNull()
  })
})
