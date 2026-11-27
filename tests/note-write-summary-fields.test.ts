// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { initializeDatabase } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings, Env } from '../src/worker/env'

const userId = 'user-1'
const noteId = 'b'.repeat(26)

let sqlite: DatabaseSync
let db: D1Database

function makeDb(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      // 惰性解析：建表语句批量 prepare 时表还未创建，立即解析会报 no such table。
      let values: unknown[] = []
      const args = () => [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return sqlite.prepare(sql).get(...args() as never[]) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...args() as never[]) } },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args() as never[]).changes) } } },
      }
      return prepared
    },
    async batch(list: { run: () => Promise<unknown> }[]) {
      return Promise.all(list.map((statement) => statement.run()))
    },
  } as unknown as D1Database
}

function request(method: string, path: string, body?: unknown) {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => {
    const status = 'status' in err ? (err.status as number) : 500
    return c.json({ error: { message: err.message }, details: (err as { details?: unknown }).details }, status as 400)
  })
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    c.set('user', { settingsRaw: '{}' } as AppBindings['Variables']['user'])
    await next()
  })
  app.route('/api/notes', notesRoutes)
  return app.request(
    path,
    {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    { DB: db } as AppBindings['Bindings'],
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  )
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  sqlite = new DatabaseSync(':memory:')
  db = makeDb(sqlite)
  await initializeDatabase({ DB: db, APP_NAME: 'Inkstone' } as unknown as Env)
  sqlite.exec(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
    VALUES ('${userId}', 'admin', 'x', 'admin', 'Admin', '', 'owner', '{}', 1, 1)`)
  sqlite.exec(`INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
      is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
    VALUES ('${noteId}', '${userId}', '标题', '标题', '正文', '', 1, 2, 2, 0, 0, 0, 0, 'h', 1, 2)`)
  sqlite.exec(`INSERT INTO note_summaries (note_id, user_id, summary_text, summary_origin, summary_language,
      source_hash, summary_status, generated_at, updated_at)
    VALUES ('${noteId}', '${userId}', '已保存摘要', 'ai', 'zh-CN', 'h', 'current', 3, 4)`)
  sqlite.exec(`INSERT INTO note_summary_settings (note_id, user_id, auto_mode, auto_generate, summary_enabled, updated_at)
    VALUES ('${noteId}', '${userId}', 'inherit', NULL, 0, 5)`)
})

describe('笔记写响应带摘要字段', () => {
  // 客户端 adoptNote 会用响应整体覆盖本地；缺字段会把已同步的摘要与单篇设置冲成默认值。
  it('PATCH 返回 summary 与 summarySettings', async () => {
    const res = await request('PATCH', `/api/notes/${noteId}`, { rev: 1, title: '新标题' })
    expect(res.status).toBe(200)
    const body = await res.json() as { summary?: { text: string }; summarySettings?: { summaryEnabled: boolean | null } }
    expect(body.summary?.text).toBe('已保存摘要')
    expect(body.summarySettings?.summaryEnabled).toBe(false)
  })

  it('空补丁（无字段变化）也返回摘要字段', async () => {
    const res = await request('PATCH', `/api/notes/${noteId}`, { rev: 1 })
    expect(res.status).toBe(200)
    const body = await res.json() as { summarySettings?: { summaryEnabled: boolean | null } }
    expect(body.summarySettings?.summaryEnabled).toBe(false)
  })

  it('冲突响应的 server 副本也带摘要字段', async () => {
    const res = await request('PATCH', `/api/notes/${noteId}`, { rev: 99, title: '过期修改' })
    expect(res.status).toBe(409)
    const body = await res.json() as {
      details?: { server?: { summary?: { text: string }; summarySettings?: { summaryEnabled: boolean | null } } }
    }
    expect(body.details?.server?.summary?.text).toBe('已保存摘要')
    expect(body.details?.server?.summarySettings?.summaryEnabled).toBe(false)
  })

  it('DELETE 返回摘要字段', async () => {
    const res = await request('DELETE', `/api/notes/${noteId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { summarySettings?: { summaryEnabled: boolean | null } }
    expect(body.summarySettings?.summaryEnabled).toBe(false)
  })
})
