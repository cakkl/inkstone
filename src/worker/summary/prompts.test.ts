import { describe, expect, it } from 'vitest'
import { PROMPT_VERSION, buildRefineSystemPrompt, buildSystemPrompt } from './prompts'

describe('摘要提示词', () => {
  it('要求单段输出，不留换行', () => {
    for (const prompt of [buildSystemPrompt('zh-CN', 'medium'), buildRefineSystemPrompt('zh-CN', 'medium')]) {
      expect(prompt).toContain('single paragraph')
      expect(prompt).toContain('without a title line or line breaks')
      expect(prompt).not.toContain('short paragraphs')
    }
  })

  it('仍然禁止 Markdown 语法', () => {
    const prompt = buildSystemPrompt('en-US', 'short')
    expect(prompt).toContain('no headings, bullets, code blocks or Markdown markup')
  })

  it('提示词版本随内容变化', () => {
    expect(PROMPT_VERSION).toBe('summary-v4')
  })
})
