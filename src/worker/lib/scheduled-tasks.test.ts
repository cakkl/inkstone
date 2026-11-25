import { describe, expect, it, vi } from 'vitest'
import { runScheduledTasks } from './scheduled-tasks'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('runScheduledTasks', () => {
  it('单个任务失败不影响同批其他任务', async () => {
    const done: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runScheduledTasks('maintenance', [
      ['ok-1', async () => { await tick(); done.push('ok-1') }],
      // 模拟 D1 抛出的 internal error。
      ['broken', async () => { throw new Error('D1_ERROR: internal error') }],
      ['ok-2', async () => { await tick(); done.push('ok-2') }],
    ], 2)

    expect(done.sort()).toEqual(['ok-1', 'ok-2'])
    // 失败要能指出是哪个任务。
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]![0])).toContain('maintenance/broken')
    errors.mockRestore()
  })

  it('全部失败也不抛出，避免整轮 cron 被记为失败', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      runScheduledTasks('batch', [
        ['a', async () => { throw new Error('boom') }],
        ['b', async () => { throw new Error('boom') }],
      ], 1),
    ).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledTimes(2)
    errors.mockRestore()
  })

  it('同时进行的任务数不超过给定并发', async () => {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, (_, index) => [
      `task-${index}`,
      async () => {
        active++
        peak = Math.max(peak, active)
        await tick()
        active--
      },
    ] as const)

    await runScheduledTasks('maintenance', tasks, 2)
    expect(peak).toBe(2)
  })
})
