import { mergeSettings } from '@shared/constants'
import type { Env } from '../env'
import { resolveSummaryPolicy } from './policy'
import { isSummaryDue, nextAvailableAt } from './quiet-window'
import { generateSummary, summarySourceHash } from './service'
import { createWorkersAiProvider } from './workers-ai'

/** 失败重试上限：超过就不再自动重试，等下次编辑重新入队。 */
export const SUMMARY_MAX_ATTEMPTS = 3
const LEASE_MS = 5 * 60 * 1000

interface QueueRow {
  note_id: string
  user_id: string
  source_hash: string
  attempts: number
  settings: string | null
  title: string | null
  content: string | null
  updated_at: number | null
}

/**
 * 笔记保存后登记一次自动摘要。已有行就更新时间与指纹，
 * 这样连续修改只会把执行时间往后推，不会堆出多个任务。
 */
export async function enqueueSummary(
  db: D1Database,
  input: {
    userId: string
    noteId: string
    sourceHash: string
    now?: number
    settingsRaw?: string
    hasSummary?: boolean
  },
): Promise<void> {
  const now = input.now ?? Date.now()
  const policy = await resolveSummaryPolicy({
    db,
    userId: input.userId,
    noteId: input.noteId,
    settingsRaw: input.settingsRaw ?? '{}',
    hasSummary: input.hasSummary ?? false,
  })
  if (!policy.autoEligible) return
  await db
    .prepare(
      `INSERT INTO note_summary_queue
         (note_id, user_id, source_hash, status, available_at, attempts, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, 0, ?5, ?5)
       ON CONFLICT(note_id) DO UPDATE SET
         source_hash = excluded.source_hash,
         status = 'pending',
         available_at = excluded.available_at,
         attempts = 0,
         lease_until = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at
       WHERE note_summary_queue.user_id = excluded.user_id`,
    )
    .bind(input.noteId, input.userId, input.sourceHash, nextAvailableAt(now), now)
    .run()
}

export async function dropQueuedSummary(db: D1Database, userId: string, noteId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM note_summary_queue WHERE note_id = ?1 AND user_id = ?2`)
    .bind(noteId, userId)
    .run()
}

/** 关闭自动生成时立刻清空积压，不必等 drain 逐条丢弃。 */
export async function clearUserQueue(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM note_summary_queue WHERE user_id = ?1 AND status = 'pending'`)
    .bind(userId)
    .run()
  return result.meta.changes ?? 0
}

/** 只给「还没有摘要」的笔记补投任务，已有摘要（含过期）不动。 */
export async function backfillMissingSummaries(
  db: D1Database,
  input: { userId: string; settingsRaw: string; minCharacters: number; now?: number },
): Promise<{ candidates: number; queued: number }> {
  const now = input.now ?? Date.now()
  const { results } = await db.prepare(
    `SELECT n.id, n.title, n.content, n.updated_at
       FROM notes n
       LEFT JOIN note_summary_settings s ON s.note_id = n.id AND s.user_id = n.user_id
       LEFT JOIN note_summaries m ON m.note_id = n.id AND m.user_id = n.user_id
      WHERE n.user_id = ?1
        AND n.deleted_at IS NULL
        AND m.note_id IS NULL
        AND (s.summary_enabled IS NULL OR s.summary_enabled = 1)
        AND (s.auto_mode IS NULL OR s.auto_mode != 'disabled')
        AND (s.auto_generate IS NULL OR s.auto_generate = 1)
        AND length(n.content) >= ?2
      ORDER BY n.updated_at DESC
      LIMIT 2000`,
  )
    .bind(input.userId, input.minCharacters)
    .all<{ id: string; title: string; content: string; updated_at: number }>()

  if (results.length === 0) return { candidates: 0, queued: 0 }

  const statements = await Promise.all(
    results.map(async (row, index) =>
      db
        .prepare(
          `INSERT INTO note_summary_queue
             (note_id, user_id, source_hash, status, available_at, attempts, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'pending', ?4, 0, ?5, ?5)
           ON CONFLICT(note_id) DO UPDATE SET
             source_hash = excluded.source_hash,
             status = 'pending',
             available_at = excluded.available_at,
             attempts = 0,
             lease_until = NULL,
             last_error = NULL,
             updated_at = excluded.updated_at
           WHERE note_summary_queue.user_id = excluded.user_id`,
        )
        .bind(
          row.id,
          input.userId,
          await summarySourceHash(row.title, row.content),
          // 摊开排期，避免整点一起涌入。
          nextAvailableAt(row.updated_at) + index * 30_000,
          now,
        ),
    ),
  )

  // D1 批里有条数上限，分批写而不是一次 2000 条。
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100))
  }
  return { candidates: results.length, queued: statements.length }
}

/** 脏 JSON 不能让整轮中断：解析失败按默认设置处理。 */
function userSettings(settingsRaw: string | null) {
  try {
    return mergeSettings(JSON.parse(settingsRaw ?? '{}'))
  } catch {
    return mergeSettings({})
  }
}

/** 只跑「静默期满 + 夜间窗口内」的任务，所以单次抓取量很小。 */
export async function drainSummaryQueue(env: Env, limit = 5, now = Date.now()): Promise<number> {
  const provider = env.AI ? createWorkersAiProvider(env.AI) : null
  if (!provider) return 0

  const { results } = await env.DB.prepare(
    `SELECT q.note_id, q.user_id, q.source_hash, q.attempts,
            u.settings AS settings, n.title, n.content, n.updated_at
       FROM note_summary_queue q
       JOIN users u ON u.id = q.user_id
       LEFT JOIN notes n ON n.id = q.note_id AND n.deleted_at IS NULL
      WHERE q.status = 'pending'
        AND q.available_at <= ?1
        AND (q.lease_until IS NULL OR q.lease_until < ?1)
      ORDER BY q.available_at ASC
      LIMIT ?2`,
  )
    .bind(now, limit)
    .all<QueueRow>()

  let processed = 0
  for (const row of results) {
    if (row.content === null || row.updated_at === null || row.title === null) {
      await dropQueuedSummary(env.DB, row.user_id, row.note_id)
      continue
    }
    const settings = userSettings(row.settings)
    const due = isSummaryDue({ now, lastEditAt: row.updated_at, timezone: settings.appearance.timezone })
    if (!due) continue
    // 排队后开关可能被关掉：这里再确认一次，关闭就丢掉任务。
    const policy = await resolveSummaryPolicy({
      db: env.DB,
      userId: row.user_id,
      noteId: row.note_id,
      settingsRaw: row.settings ?? '{}',
      hasSummary: true,
    })
    if (!policy.autoEligible || !policy.visible) {
      await dropQueuedSummary(env.DB, row.user_id, row.note_id)
      continue
    }

    // 正文又变了：等下一轮按新的 available_at 处理。
    const currentHash = await summarySourceHash(row.title, row.content)
    if (currentHash !== row.source_hash) {
      await enqueueSummary(env.DB, {
        userId: row.user_id,
        noteId: row.note_id,
        sourceHash: currentHash,
        now: row.updated_at,
      })
      continue
    }

    await env.DB.prepare(
      `UPDATE note_summary_queue
          SET status = 'running', lease_until = ?2, attempts = attempts + 1, updated_at = ?3
        WHERE note_id = ?1`,
    )
      .bind(row.note_id, now + LEASE_MS, now)
      .run()

    const outcome = await generateSummary({
      db: env.DB,
      provider,
      userId: row.user_id,
      note: { id: row.note_id, title: row.title, content: row.content },
      locale: settings.appearance.language,
    })

    if (outcome.ok) {
      await dropQueuedSummary(env.DB, row.user_id, row.note_id)
      processed += 1
      continue
    }

    // 额度耗尽不是这篇笔记的问题：保留任务，等额度恢复。
    if (outcome.code === 'quota_exhausted') {
      await env.DB.prepare(
        `UPDATE note_summary_queue SET status = 'pending', lease_until = NULL, updated_at = ?2 WHERE note_id = ?1`,
      )
        .bind(row.note_id, now)
        .run()
      break
    }

    if (row.attempts + 1 >= SUMMARY_MAX_ATTEMPTS) {
      await dropQueuedSummary(env.DB, row.user_id, row.note_id)
      continue
    }
    await env.DB.prepare(
      `UPDATE note_summary_queue
          SET status = 'pending', lease_until = NULL, last_error = ?2,
              available_at = ?3, updated_at = ?4
        WHERE note_id = ?1`,
    )
      .bind(row.note_id, outcome.code, now + 60 * 60 * 1000, now)
      .run()
  }
  return processed
}
