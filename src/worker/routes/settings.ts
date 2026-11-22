import { Hono } from 'hono'
import { LIMITS, mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { UserSettings } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { commitChange } from '../lib/notify'
import { getAiSummarySettings, setAiSummarySettings, setAllowRegistration } from '../lib/instance-settings'
import { clearAiSummaryPurge, markAiSummaryPurge } from '../summary/purge'
import { backfillMissingSummaries, clearUserQueue } from '../summary/queue'
import { requireCurrentPassword } from '../lib/reauth'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

export const settingsRoutes = new Hono<AppBindings>()

settingsRoutes.use('*', requireAuth)

const STATS_CACHE_TTL_MS = 60_000


settingsRoutes.put('/registration', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') throw ApiError.forbidden('Only the owner can change this setting')
  const body = await readJson<{ enabled?: boolean; password?: string }>(c, 4096)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('Missing enabled parameter')
  await requireCurrentPassword(c.env.DB, user.id, body.password)
  await setAllowRegistration(c.env.DB, body.enabled)
  await commitChange(c, 'site', user.id, 'upsert')
  return c.json({ ok: true, registrationOpen: body.enabled })
})

settingsRoutes.get('/', (c) => {
  const user = c.get('user')
  return c.json(mergeSettings(parse(user.settingsRaw)))
})

settingsRoutes.get('/ai-summary', async (c) => {
  const userId = c.get('userId')
  const [instance, depth] = await Promise.all([
    getAiSummarySettings(c.env.DB),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM note_summary_queue WHERE user_id = ?1 AND status = 'pending'`,
    )
      .bind(userId)
      .first<{ count: number }>(),
  ])
  return c.json({ ...instance, queueDepth: depth?.count ?? 0 })
})

/** 只补「还没有摘要」的笔记；已有摘要（含过期）保持不动。 */
settingsRoutes.post('/ai-summary/backfill', async (c) => {
  const user = c.get('user')
  const settings = mergeSettings(parse(user.settingsRaw))
  if (!settings.aiSummary.enabled || !settings.aiSummary.autoGenerate) {
    throw ApiError.badRequest('Enable automatic summaries first')
  }
  // 实例不允许自动摘要时补投只会入队后被丢弃，直接拒绝更清楚。
  const instance = await getAiSummarySettings(c.env.DB)
  if (!instance.enabled || !instance.allowAutoGenerate) {
    throw ApiError.badRequest('Automatic summaries are disabled for this instance')
  }
  const result = await backfillMissingSummaries(c.env.DB, {
    userId: user.id,
    settingsRaw: user.settingsRaw,
    minCharacters: LIMITS.aiSummaryMinChars,
  })
  return c.json(result)
})

settingsRoutes.put('/ai-summary', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') throw ApiError.forbidden('Only the owner can change this setting')
  const body = await readJson<{ enabled?: boolean; allowAutoGenerate?: boolean }>(c, 4096)
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw ApiError.badRequest('enabled must be a boolean')
  }
  if (body.allowAutoGenerate !== undefined && typeof body.allowAutoGenerate !== 'boolean') {
    throw ApiError.badRequest('allowAutoGenerate must be a boolean')
  }
  const next = await setAiSummarySettings(c.env.DB, {
    enabled: body.enabled,
    allowAutoGenerate: body.allowAutoGenerate,
  })
  await commitChange(c, 'site', user.id, 'upsert')
  return c.json(next)
})

settingsRoutes.put('/', async (c) => {
  const userId = c.get('userId')
  const incoming = await readJson<Partial<UserSettings>>(c, JSON_BODY_LIMITS.settings)
  let previousRaw = c.get('user').settingsRaw
  for (let attempt = 0; attempt < 5; attempt++) {

    const previous = mergeSettings(parse(previousRaw))
    const merged = mergeSettingsPatch(parse(previousRaw), incoming)
    const nextRaw = JSON.stringify(merged)
    const updated = await c.env.DB.prepare(
      `UPDATE users SET settings = ?1 WHERE id = ?2 AND settings = ?3`,
    )
      .bind(nextRaw, userId, previousRaw)
      .run()
    if (updated.meta.changes) {
      // 关闭 AI 摘要 = 删掉 AI 写的（手写保留）。数量可能很大，走排队清理。
      if (previous.aiSummary.enabled && !merged.aiSummary.enabled) {
        await markAiSummaryPurge(c.env.DB, userId, Date.now()).catch(() => undefined)
      } else if (!previous.aiSummary.enabled && merged.aiSummary.enabled) {
        await clearAiSummaryPurge(c.env.DB, userId).catch(() => undefined)
      }
      // 关掉自动生成就别再排队了：否则积压会留到下次开启。
      if (previous.aiSummary.autoGenerate && !merged.aiSummary.autoGenerate) {
        await clearUserQueue(c.env.DB, userId).catch(() => undefined)
      }
      await commitChange(c, 'settings', userId, 'upsert')
      return c.json(merged)
    }
    const latest = await c.env.DB.prepare(`SELECT settings FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ settings: string }>()
    if (!latest) throw ApiError.unauthenticated()
    previousRaw = latest.settings
  }
  throw new ApiError(409, 'conflict', 'Settings keep changing elsewhere. Try again shortly')
})


settingsRoutes.get('/stats', async (c) => {
  const userId = c.get('userId')
  const now = Date.now()
  const cacheKey = `stats-v1:${userId}`
  const cached = await c.env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?1`)
    .bind(cacheKey)
    .first<{ value: string }>()
  if (cached) {
    try {
      const value = JSON.parse(cached.value) as Record<string, unknown>
      const fresh = typeof value.at === 'number' && now - value.at < STATS_CACHE_TTL_MS
      const shaped = typeof value.versions === 'number' && typeof value.attachments === 'number' &&
        typeof value.attachmentBytes === 'number'
      if (fresh && shaped) {
        return c.json({
          versions: value.versions,
          attachments: value.attachments,
          attachmentBytes: value.attachmentBytes,
        })
      }
    } catch {
    }
  }
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM note_versions WHERE user_id = ?1) AS versions,
            (SELECT COUNT(*) FROM attachments WHERE user_id = ?1) AS attachments,
            (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE user_id = ?1) AS attachmentBytes`,
  )
    .bind(userId)
    .first<{ versions: number; attachments: number; attachmentBytes: number }>()
  const values = {
    versions: Number(row?.versions ?? 0),
    attachments: Number(row?.attachments ?? 0),
    attachmentBytes: Number(row?.attachmentBytes ?? 0),
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(cacheKey, JSON.stringify({ at: now, ...values }))
      .run()
  } catch {
  }
  return c.json(values)
})

function parse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
