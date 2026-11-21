import { describe, expect, it } from 'vitest'
import { resolveSummaryPolicy } from './policy'
import type { Env } from '../env'

/** 用最小 stub 覆盖策略矩阵：实例、用户、单篇三项、是否有内容。改规则先看这张表。 */
function fakeDb(options: {
  instance?: { enabled: boolean; allowAutoGenerate: boolean }
  flags?: { summary_enabled: number | null; auto_mode: string; auto_generate: number | null } | null
} = {}) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            run: async () => ({ success: true, meta: { changes: 0 } }),
            first: async () => {
              if (sql.includes('app_meta')) {
                return { value: JSON.stringify(options.instance ?? { enabled: true, allowAutoGenerate: true }) }
              }
              if (sql.includes('note_summary_settings')) return options.flags ?? null
              return null
            },
            all: async () => ({ results: [] }),
          }
        },
      }
    },
  } as unknown as D1Database
}

const userSettings = (enabled: boolean, autoGenerate: boolean) =>
  JSON.stringify({ aiSummary: { enabled, autoGenerate } })

const base = {
  userId: 'u1',
  noteId: 'n1',
  settingsRaw: userSettings(true, false),
}

describe('summary policy matrix', () => {
  it('hides the panel for an empty note when auto generation is off', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      db: fakeDb(),
      hasSummary: false,
    })
    expect(policy.visible).toBe(false)
    expect(policy.canGenerate).toBe(true)
    expect(policy.autoEligible).toBe(false)
  })

  it('shows the panel for an empty note when auto generation is on', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      settingsRaw: userSettings(true, true),
      db: fakeDb(),
      hasSummary: false,
    })
    expect(policy.visible).toBe(true)
    expect(policy.autoEligible).toBe(true)
  })

  it('shows the panel when the note already has a summary', async () => {
    const policy = await resolveSummaryPolicy({ ...base, db: fakeDb(), hasSummary: true })
    expect(policy.visible).toBe(true)
  })

  it('honours an explicit per-note setting over the derived default', async () => {
    const on = await resolveSummaryPolicy({
      ...base,
      db: fakeDb({ flags: { summary_enabled: 1, auto_mode: 'inherit', auto_generate: null } }),
      hasSummary: false,
    })
    expect(on.visible).toBe(true)

    const off = await resolveSummaryPolicy({
      ...base,
      db: fakeDb({ flags: { summary_enabled: 0, auto_mode: 'inherit', auto_generate: null } }),
      hasSummary: true,
    })
    expect(off.visible).toBe(false)
  })

  it('blocks AI generation but keeps the panel when the user turns AI off', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      settingsRaw: userSettings(false, true),
      db: fakeDb(),
      hasSummary: true,
    })
    expect(policy.visible).toBe(true)
    expect(policy.canGenerate).toBe(false)
    expect(policy.autoEligible).toBe(false)
  })

  it('treats the instance switch as the outer limit', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      settingsRaw: userSettings(true, true),
      db: fakeDb({ instance: { enabled: false, allowAutoGenerate: true } }),
      hasSummary: false,
    })
    expect(policy.canGenerate).toBe(false)
    expect(policy.visible).toBe(false)
  })

  it('lets a note opt into auto without the user default', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      db: fakeDb({ flags: { summary_enabled: null, auto_mode: 'inherit', auto_generate: 1 } }),
      hasSummary: false,
    })
    expect(policy.autoEligible).toBe(true)
    expect(policy.visible).toBe(true)
  })

  it('never auto-generates for a note with AI disabled', async () => {
    const policy = await resolveSummaryPolicy({
      ...base,
      settingsRaw: userSettings(true, true),
      db: fakeDb({ flags: { summary_enabled: null, auto_mode: 'disabled', auto_generate: 1 } }),
      hasSummary: true,
    })
    expect(policy.canGenerate).toBe(false)
    expect(policy.autoEligible).toBe(false)
  })
})

export type { Env }
