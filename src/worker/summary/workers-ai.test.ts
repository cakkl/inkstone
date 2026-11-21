import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { createWorkersAiProvider, SUMMARY_MODEL } from './workers-ai'

/**
 * 一次真实的 Workers AI 调用响应（`@cf/meta/llama-3.1-8b-instruct-fast`，2026-11-21），
 * 只保留 provider 读取的字段。用它校验响应映射，不依赖能连通 AI 的环境。
 */
const chatResponse = {
  model: '@cf/meta/llama-3.1-8b-fast-v2',
  choices: [
    {
      message: {
        content: '迁移 15：新增 note_summaries 表，用于存储笔记的正式摘要。表中包含 summary_text、summary_origin、source_hash 和 summary_status 字段。',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 109, completion_tokens: 69, neurons: 2.8548033237457275 },
}

/** 夹具来自一次真实的 `@cf/meta/llama-3.1-8b-instruct-fast` 调用，见上。 */
function fakeAi(result: unknown) {
  const calls: { model: string; input: unknown }[] = []
  const binding = {
    async run(model: string, input: unknown) {
      calls.push({ model, input })
      return result
    },
  } as NonNullable<Env['AI']>
  return { calls, binding }
}

describe('createWorkersAiProvider', () => {
  it('maps a real Workers AI chat response', async () => {
    const { binding, calls } = fakeAi(chatResponse)
    const provider = createWorkersAiProvider(binding)
    const result = await provider.generate({
      title: '迁移 15',
      content: '新增 note_summaries 表',
      language: 'zh-CN',
      length: 'medium',
    })

    expect(calls[0]!.model).toBe(SUMMARY_MODEL)
    expect(result.text).toBe(chatResponse.choices[0]!.message.content)
    expect(result.model).toBe('@cf/meta/llama-3.1-8b-fast-v2')
    expect(result.inputTokens).toBe(109)
    expect(result.outputTokens).toBe(69)
    expect(result.neurons).toBeCloseTo(2.8548, 3)
    expect(result.truncated).toBe(false)
  })

  it('asks the model for the length preset and the locale language', async () => {
    const { binding, calls } = fakeAi(chatResponse)
    await createWorkersAiProvider(binding).generate({
      title: 'T',
      content: 'C',
      language: 'en-US',
      length: 'short',
    })
    const input = calls[0]!.input as { messages: { role: string; content: string }[]; max_tokens: number }
    expect(input.max_tokens).toBe(300)
    expect(input.messages[0]!.content).toContain('English')
  })

  it('flags truncation so the caller can refuse the result', async () => {
    const truncated = {
      ...chatResponse,
      choices: [{ ...chatResponse.choices[0], finish_reason: 'length' }],
    }
    const { binding } = fakeAi(truncated)
    const result = await createWorkersAiProvider(binding).generate({
      title: 'T',
      content: 'C',
      language: 'zh-CN',
      length: 'medium',
    })
    expect(result.truncated).toBe(true)
  })

  it('reads the legacy string response shape', async () => {
    const { binding } = fakeAi({ response: '旧的返回格式' })
    const result = await createWorkersAiProvider(binding).generate({
      title: 'T',
      content: 'C',
      language: 'zh-CN',
      length: 'medium',
    })
    expect(result.text).toBe('旧的返回格式')
    expect(result.neurons).toBe(0)
  })

  it('rejects an empty answer instead of storing a blank summary', async () => {
    const { binding } = fakeAi({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] })
    await expect(
      createWorkersAiProvider(binding).generate({ title: 'T', content: 'C', language: 'zh-CN', length: 'medium' }),
    ).rejects.toThrow(/empty/i)
  })

  it('wraps binding failures in a provider error', async () => {
    const binding = {
      async run() {
        throw new Error('boom')
      },
    } as unknown as NonNullable<Env['AI']>
    await expect(
      createWorkersAiProvider(binding).generate({ title: 'T', content: 'C', language: 'zh-CN', length: 'medium' }),
    ).rejects.toThrow('boom')
  })
})
