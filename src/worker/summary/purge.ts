import { getMeta, setMeta } from '../db/metadata'
import { notifySummaryChanged } from './sync-rows'

/** 关闭 AI 摘要要真删内容，但不在设置请求里同步删几百篇：打标记，定时任务分批处理。 */
const PURGE_KEY_PREFIX = 'ai_summary_purge:'

export interface PurgeMarker {
  /** 只删这个时刻之前创建/更新的行，避免删掉重新开启后新生成的内容。 */
  startedAt: number
}
/** D1 单个查询最多 99 个绑定参数（含 userId），按 80 分块删除。 */
const DELETE_CHUNK = 80
export async function markAiSummaryPurge(db: D1Database, userId: string, startedAt: number): Promise<void> {
  await setMeta(db, `${PURGE_KEY_PREFIX}${userId}`, JSON.stringify({ startedAt } satisfies PurgeMarker))
}

export async function clearAiSummaryPurge(db: D1Database, userId: string): Promise<void> {
  await setMeta(db, `${PURGE_KEY_PREFIX}${userId}`, '')
}

export async function readAiSummaryPurge(db: D1Database, userId: string): Promise<PurgeMarker | null> {
  const raw = await getMeta(db, `${PURGE_KEY_PREFIX}${userId}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PurgeMarker>
    return typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : null
  } catch {
    return null
  }
}

/** 单篇关闭摘要：数据量很小，直接同步删干净（含历史版本）。 */
export async function purgeNoteSummary(db: D1Database, userId: string, noteId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM note_summaries WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
    db.prepare(`DELETE FROM note_summary_drafts WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
    db.prepare(`DELETE FROM note_summary_versions WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
    db.prepare(`DELETE FROM note_summary_queue WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
  ])
  await notifySummaryChanged(db, userId, noteId, 'delete')
}

/** 单篇关闭 AI 摘要：只删 AI 生成的，手写摘要与历史保留。 */
export async function purgeAiSummary(db: D1Database, userId: string, noteId: string): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM note_summaries WHERE note_id = ?1 AND user_id = ?2 AND summary_origin = 'ai'`,
    ).bind(noteId, userId),
    db.prepare(`DELETE FROM note_summary_drafts WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
    db.prepare(`DELETE FROM note_summary_queue WHERE note_id = ?1 AND user_id = ?2`).bind(noteId, userId),
  ])
  await notifySummaryChanged(db, userId, noteId, 'delete')
}

/** 分批清理该用户全部 AI 摘要，返回删除行数；0 表示已清完（调用方据此清标记）。 */
export async function drainAiSummaryPurge(
  db: D1Database,
  userId: string,
  startedAt: number,
  limit = 200,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT note_id FROM note_summaries
        WHERE user_id = ?1 AND summary_origin = 'ai' AND updated_at <= ?2
        LIMIT ?3`,
    )
    .bind(userId, startedAt, limit)
    .all<{ note_id: string }>()
  if (results.length) {
    const ids = results.map((row) => row.note_id)
    // 200 条一次性拼进 IN 会超过 D1 的参数上限，按块删除。
    for (let offset = 0; offset < ids.length; offset += DELETE_CHUNK) {
      const chunk = ids.slice(offset, offset + DELETE_CHUNK)
      const marks = chunk.map(() => '?').join(', ')
      await db
        .prepare(`DELETE FROM note_summaries WHERE user_id = ?1 AND note_id IN (${marks})`)
        .bind(userId, ...chunk)
        .run()
    }
    await db.batch([
      db.prepare(`DELETE FROM note_summary_drafts WHERE user_id = ?1 AND created_at <= ?2`)
        .bind(userId, startedAt),
      db.prepare(`DELETE FROM note_summary_queue WHERE user_id = ?1`).bind(userId),
    ])
    return results.length
  }

  // 摘要删完了，再收尾草稿与队列。
  const drafts = await db
    .prepare(`DELETE FROM note_summary_drafts WHERE user_id = ?1 AND created_at <= ?2`)
    .bind(userId, startedAt)
    .run()
  const queued = await db.prepare(`DELETE FROM note_summary_queue WHERE user_id = ?1`).bind(userId).run()
  return (drafts.meta.changes ?? 0) + (queued.meta.changes ?? 0)
}
