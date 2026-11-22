import type { Env } from '../env'
import { clearAiSummaryPurge, drainAiSummaryPurge, readAiSummaryPurge } from './purge'

/** 每轮处理的用户数；单个用户每轮最多删 200 行，避免一次打满 D1 写入额度。 */
const USERS_PER_RUN = 3

/** 处理关闭 AI 摘要留下的清理标记；删完清标记，期间重新开启会撤标记，新内容不会被误删。 */
export async function drainPendingPurges(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM app_meta WHERE key LIKE 'ai_summary_purge:%' AND value LIKE '%startedAt%' LIMIT ?1`,
  )
    .bind(USERS_PER_RUN)
    .all<{ key: string; value: string }>()

  let removed = 0
  for (const row of results) {
    const userId = row.key.slice('ai_summary_purge:'.length)
    const marker = await readAiSummaryPurge(env.DB, userId)
    if (!marker) {
      await clearAiSummaryPurge(env.DB, userId).catch(() => undefined)
      continue
    }
    const deleted = await drainAiSummaryPurge(env.DB, userId, marker.startedAt)
    removed += deleted
    if (deleted === 0) await clearAiSummaryPurge(env.DB, userId).catch(() => undefined)
  }
  return removed
}
