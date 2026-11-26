// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'

/** 用 node:sqlite 模拟 D1：只实现 schema 初始化实际用到的方法。 */
function makeDb(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const args = () => [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
      const prepared = {
        bind(...bound: unknown[]) {
          values = bound
          return prepared
        },
        async first() {
          return sqlite.prepare(sql).get(...args() as never[]) ?? null
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args() as never[]) }
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args() as never[]).changes) } }
        },
      }
      return prepared
    },
    async batch(list: { run: () => Promise<unknown> }[]) {
      return Promise.all(list.map((statement) => statement.run()))
    },
  } as unknown as D1Database
}

function makeEnv(sqlite: DatabaseSync): Env {
  vi.stubGlobal('crypto', webcrypto)
  return { DB: makeDb(sqlite), APP_NAME: 'Inkstone' } as unknown as Env
}

function tableColumns(sqlite: DatabaseSync, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
}

describe('数据库初始化', () => {
  it('空库会跑完全部迁移', async () => {
    const sqlite = new DatabaseSync(':memory:')
    expect(await initializeDatabase(makeEnv(sqlite))).toBeTruthy()
    expect(tableColumns(sqlite, 'shares')).toContain('include_summary')
    expect(tableColumns(sqlite, 'note_summaries')).toContain('summary_evolved')
    expect(tableColumns(sqlite, 'note_summary_settings')).toContain('summary_enabled')
  })

  it('既有库第二次启动不会再跑迁移', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    expect(await initializeDatabase(makeEnv(sqlite))).toBeTruthy()
    expect(await initializeDatabase(makeEnv(sqlite))).toBeTruthy()
  })

  it('列已加过但迁移记录缺失时仍能启动（并发冷启动残留）', async () => {
    const sqlite = new DatabaseSync(':memory:')
    expect(await initializeDatabase(makeEnv(sqlite))).toBeTruthy()
    // 模拟另一个 isolate 已落库、但本 isolate 读到的版本表还没跟上。
    sqlite.exec(`DELETE FROM schema_migrations WHERE version IN (19, 20, 21)`)
    sqlite.exec(`DELETE FROM app_meta WHERE key = 'database-state-v1'`)
    expect(await initializeDatabase(makeEnv(sqlite))).toBeTruthy()
    const applied = (sqlite.prepare(`SELECT version FROM schema_migrations WHERE version IN (19, 20, 21)`)
      .all() as { version: number }[]).map((row) => row.version)
    expect(applied.sort()).toEqual([19, 20, 21])
  })

  // 缓存未完成的 promise 会让后续请求 await 到一个永远不 settle 的对象。
  it('同一数据库的两次调用不共用 promise', () => {
    const env = makeEnv(new DatabaseSync(':memory:'))
    expect(initializeDatabase(env)).not.toBe(initializeDatabase(env))
  })

  it('初始化失败不写缓存，下一次调用会重新执行', async () => {
    const sqlite = new DatabaseSync(':memory:')
    const base = makeDb(sqlite)
    let failOnce = true
    const flaky = {
      prepare(sql: string) {
        const prepared = base.prepare(sql)
        if (!failOnce) return prepared
        return {
          ...prepared,
          async first() {
            failOnce = false
            throw new Error('D1 瞬时故障')
          },
        }
      },
      batch: base.batch.bind(base),
    } as unknown as D1Database
    vi.stubGlobal('crypto', webcrypto)
    const env = { DB: flaky, APP_NAME: 'Inkstone' } as unknown as Env

    await expect(initializeDatabase(env)).rejects.toThrow('D1 瞬时故障')
    expect(await initializeDatabase(env)).toBeTruthy()
  })
})
