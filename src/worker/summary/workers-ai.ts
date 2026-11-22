import type { Env } from '../env'
import { buildRefineSystemPrompt, buildRefineUserPrompt, buildSystemPrompt, buildUserPrompt, LENGTH_PRESETS, PROMPT_VERSION } from './prompts'
import { SummaryProviderError, type SummaryProvider, type SummaryRequest, type SummaryResult } from './provider'

/** 实测最佳性价比：中文摘要准确、保留数字与路径，2 秒左右返回。 */
export const SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

/**
 * 正文超过该长度时截断。8000 字符实测约 4478 输入 tokens；
 * 继续放大只会让模型注意力分散，且成本线性上涨。
 */
export const SUMMARY_INPUT_MAX_CHARS = 12_000

interface ChatResult {
  model?: string
  response?: string
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number }
}

export function createWorkersAiProvider(ai: NonNullable<Env['AI']>): SummaryProvider {
  return {
    async generate(request: SummaryRequest): Promise<SummaryResult> {
      const preset = LENGTH_PRESETS[request.length]
      const content = request.content.slice(0, SUMMARY_INPUT_MAX_CHARS)
      const refine = Boolean(request.previousSummary)
      const result = await ai.run(SUMMARY_MODEL, {
        messages: [
          {
            role: 'system',
            content: refine
              ? buildRefineSystemPrompt(request.language, request.length)
              : buildSystemPrompt(request.language, request.length),
          },
          {
            role: 'user',
            content: refine
              ? buildRefineUserPrompt(request.title, content, request.previousSummary!, request.instruction)
              : buildUserPrompt(request.title, content),
          },
        ],
        max_tokens: preset.maxTokens,
        temperature: 0.2,
      }).catch((error: unknown) => {
        throw new SummaryProviderError(
          error instanceof Error ? error.message : 'AI request failed',
          'ai_request_failed',
        )
      }) as ChatResult

      const choice = result.choices?.[0]
      const text = (choice?.message?.content ?? result.response ?? '').trim()
      if (!text) {
        throw new SummaryProviderError('AI returned an empty summary', 'ai_empty_result')
      }
      return {
        text,
        model: result.model ?? SUMMARY_MODEL,
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
        neurons: result.usage?.neurons ?? 0,
        truncated: choice?.finish_reason === 'length',
      }
    },
  }
}

export { PROMPT_VERSION }
