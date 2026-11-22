import { beforeEach, describe, expect, it } from 'vitest'
import {
  SUMMARY_CACHE_MAX_AGE_MS,
  clearSummaryCache,
  dropCachedSummary,
  readCachedSummary,
  writeCachedSummary,
} from './summary-cache'
import type { AiNoteSummaryResponse } from '@shared/types'

function snapshot(noteId: string, text: string): AiNoteSummaryResponse {
  return {
    summary: {
      noteId,
      text,
      origin: 'ai',
      status: 'current',
      language: 'zh-CN',
      model: 'test-model',
      generatedAt: 1,
      updatedAt: 1,
    },
    minimumCharacters: 100,
    characterCount: 200,
    remainingNeurons: 1000,
    visible: true,
    canGenerate: true,
    autoEligible: false,
    queued: false,
    settings: { summaryEnabled: null, aiMode: 'inherit', autoGenerate: null },
  }
}

describe('摘要缓存', () => {
  beforeEach(() => {
    clearSummaryCache()
  })

  it('写进去的摘要可以立即读出来', () => {
    writeCachedSummary('u1', 'n1', snapshot('n1', '第一条'))
    expect(readCachedSummary('u1', 'n1')?.summary?.text).toBe('第一条')
  })

  it('不同用户的缓存互不可见', () => {
    writeCachedSummary('u1', 'n1', snapshot('n1', 'u1 的摘要'))
    expect(readCachedSummary('u2', 'n1')).toBeNull()
  })

  it('超过时限不再作为首屏快照，但允许按过期快照占位', () => {
    writeCachedSummary('u1', 'n1', snapshot('n1', '旧摘要'))
    const later = Date.now() + SUMMARY_CACHE_MAX_AGE_MS + 1
    expect(readCachedSummary('u1', 'n1', { now: later })).toBeNull()
    expect(readCachedSummary('u1', 'n1', { allowStale: true, now: later })?.summary?.text).toBe('旧摘要')
  })

  it('删掉单篇后读不到，清空后所有缓存失效', () => {
    writeCachedSummary('u1', 'n1', snapshot('n1', 'A'))
    writeCachedSummary('u1', 'n2', snapshot('n2', 'B'))
    dropCachedSummary('u1', 'n1')
    expect(readCachedSummary('u1', 'n1')).toBeNull()
    expect(readCachedSummary('u1', 'n2')).not.toBeNull()
    clearSummaryCache()
    expect(readCachedSummary('u1', 'n2')).toBeNull()
  })

  it('没有登录用户时不写入也不读取', () => {
    writeCachedSummary(null, 'n1', snapshot('n1', 'x'))
    expect(readCachedSummary(null, 'n1')).toBeNull()
  })
})
