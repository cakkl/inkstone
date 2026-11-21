import { LIMITS } from '@shared/constants'

export interface UsageTotals {
  requests: number
  neurons: number
}

/** UTC 日期键；Worker 与 D1 均以 UTC 计日，避免时区漂移。 */
export function utcDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 今天的剩余额度；`-1` 表示不限制（未配置上限时）。 */
export function remainingNeurons(used: number, limit: number = LIMITS.aiSummaryDailyNeurons): number {
  if (limit <= 0) return -1
  return Math.max(0, limit - used)
}

export async function readUsage(db: D1Database, userId: string, date = utcDateKey()): Promise<UsageTotals> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS requests, COALESCE(SUM(neurons), 0) AS neurons
         FROM ai_summary_usage_daily WHERE user_id = ?1 AND date_utc = ?2`,
    )
    .bind(userId, date)
    .first<{ requests: number; neurons: number }>()
  return { requests: row?.requests ?? 0, neurons: row?.neurons ?? 0 }
}

export async function recordUsage(
  db: D1Database,
  params: {
    userId: string
    model: string
    neurons: number
    inputTokens: number
    outputTokens: number
    success: boolean
    date?: string
  },
): Promise<void> {
  const date = params.date ?? utcDateKey()
  // 失败也要计数：否则模型挂了会无限重试直到把额度烧光。
  await db
    .prepare(
      `INSERT INTO ai_summary_usage_daily
         (user_id, date_utc, model, request_count, success_count, failure_count, input_tokens, output_tokens, neurons)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(user_id, date_utc, model) DO UPDATE SET
         request_count = request_count + 1,
         success_count = success_count + excluded.success_count,
         failure_count = failure_count + excluded.failure_count,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         neurons = neurons + excluded.neurons`,
    )
    .bind(
      params.userId,
      date,
      params.model,
      params.success ? 1 : 0,
      params.success ? 0 : 1,
      params.inputTokens,
      params.outputTokens,
      params.neurons,
    )
    .run()
}
