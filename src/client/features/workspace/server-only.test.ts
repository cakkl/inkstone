import { describe, expect, it, vi } from 'vitest'
import { runServerOnly } from './server-only'

describe('runServerOnly', () => {
    it('有阻塞理由时只提示，不执行动作', () => {
        const notify = vi.fn()
        const run = vi.fn()
        runServerOnly('草稿尚未保存到服务器', notify, run)
        expect(notify).toHaveBeenCalledWith('草稿尚未保存到服务器')
        expect(run).not.toHaveBeenCalled()
    })

    it('无阻塞理由时执行动作且不提示', () => {
        const notify = vi.fn()
        const run = vi.fn()
        runServerOnly(null, notify, run)
        expect(notify).not.toHaveBeenCalled()
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('离线理由同样只提示，不复用草稿文案', () => {
        const notify = vi.fn()
        const run = vi.fn()
        runServerOnly('离线时不可用', notify, run)
        expect(notify).toHaveBeenCalledWith('离线时不可用')
        expect(run).not.toHaveBeenCalled()
    })
})
