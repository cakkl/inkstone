import { LIMITS } from '@shared/constants'

/**
 * 自动摘要的调度规则：静默期已满 + 处于用户本地夜间窗口，两者同时成立才执行。
 * 只靠静默期会在傍晚你还在用时触发；只靠窗口会在凌晨编辑时当场插入。
 */
export const SUMMARY_QUIET_MS = LIMITS.aiSummaryQuietHours * 60 * 60 * 1000
export const SUMMARY_QUEUE_MAX_AGE_MS = LIMITS.aiSummaryQueueMaxAgeHours * 60 * 60 * 1000

/** 未知或非法时区回落 UTC，避免任务永远不执行。 */
export function safeTimezone(timezone: string | null | undefined): string {
  if (!timezone) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return timezone
  } catch {
    return 'UTC'
  }
}

/** 指定时刻在该时区的小时数（0–23）。 */
export function localHour(now: number, timezone: string | null | undefined): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone(timezone),
    hour: 'numeric',
    hour12: false,
  }).format(new Date(now))
  // `hour12: false` 在部分实现里会给 24 表示午夜。
  return Number(formatted) % 24
}

export function isWithinQuietWindow(now: number, timezone: string | null | undefined): boolean {
  const hour = localHour(now, timezone)
  return hour >= LIMITS.aiSummaryWindowStartHour && hour < LIMITS.aiSummaryWindowEndHour
}

/** 最早可执行的时刻：最后一次修改 + 静默期。 */
export function nextAvailableAt(lastEditAt: number): number {
  return lastEditAt + SUMMARY_QUIET_MS
}

export function isSummaryDue(input: {
  now: number
  lastEditAt: number
  timezone: string | null | undefined
}): boolean {
  return input.now >= nextAvailableAt(input.lastEditAt) && isWithinQuietWindow(input.now, input.timezone)
}

/** 积压太久的任务作废：重新按当前时间排期，而不是立刻补跑。 */
export function isSummaryStale(queuedAt: number, now: number): boolean {
  return now - queuedAt > SUMMARY_QUEUE_MAX_AGE_MS
}
