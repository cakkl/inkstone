import { forEachConcurrent } from '../backup/concurrency'

export type ScheduledTaskEntry = readonly [name: string, run: () => Promise<unknown>]

/**
 * 分批执行定时任务。
 *
 * - 单个任务失败只记一条日志，不连累同批其他任务，也不让整轮 cron 记为失败：
 *   此前一处 D1 瞬时错误就会掩盖掉其余任务全部成功的事实。
 * - `concurrency` 限制同时进行的任务数，避免多个任务同时向同一个 D1 发查询
 *   （曾因并发峰值触发 `D1_ERROR: internal error`）。
 */
export async function runScheduledTasks(
  group: string,
  tasks: readonly ScheduledTaskEntry[],
  concurrency: number,
): Promise<void> {
  // 错误已在 run 内部消化，因此不会触发 forEachConcurrent 的快速失败。
  await forEachConcurrent(tasks, concurrency, async ([name, run]) => {
    try {
      await run()
    } catch (error) {
      // 任务名作为独立参数传入，不拼进格式串。
      console.error('[inkstone] Scheduled task failed:', group, name, error)
    }
  })
}
