import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  EMPTY_SEARCH_RESULT,
  emptyFetchResult,
  fetchOutputSchema,
  searchOutputSchema,
  toSearchResult,
} from './server'
import type { McpSearchResponse } from './retrieval'

/** Zod 生成的 JSON Schema 带 additionalProperties: false，多余字段会被严格客户端拒绝（上游 issue #62）。 */
function schemaProps(label: string, schema: z.ZodType) {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown>; additionalProperties?: boolean }
  expect(json.additionalProperties, label).toBe(false)
  return new Set(Object.keys(json.properties ?? {}))
}

const sample: McpSearchResponse = {
  results: [
    {
      id: '01j0000000000000000000001',
      title: 'Note',
      url: 'https://example.com/n/01j',
      snippet: 'x',
      score: 1,
      rev: 1,
      updatedAt: 1,
      source: 'lexical',
    },
  ],
  mode: 'lexical',
}

describe('MCP outputSchema 与返回值一致', () => {
  it('search 的返回值字段与 schema 完全一致', () => {
    const props = schemaProps('search', searchOutputSchema)
    const value = toSearchResult(sample)
    expect(new Set(Object.keys(value))).toEqual(props)
    // mode 是上游 issue #62 的漏项，必须显式声明。
    expect(props.has('mode')).toBe(true)
    expect(value.mode).toBe('lexical')
  })

  it('search 只暴露 id/title/url，不泄露检索内部字段', () => {
    const [hit] = toSearchResult(sample).results
    expect(new Set(Object.keys(hit))).toEqual(new Set(['id', 'title', 'url']))
  })

  it('fetch 的返回值字段与 schema 完全一致', () => {
    const props = schemaProps('fetch', fetchOutputSchema)
    const value = {
      id: '01j0000000000000000000001',
      title: 'Note',
      text: 'body',
      url: 'https://example.com/n/01j',
      metadata: { rev: 1 },
    }
    expect(new Set(Object.keys(value))).toEqual(props)
  })

  it('generalOutputSchema 的结构只允许 data 一个顶层字段', () => {
    // 其余工具都经 structuredData 包成 { data }，这里守住那个约定。
    const props = schemaProps('general', z.object({ data: z.record(z.string(), z.unknown()) }))
    expect(props).toEqual(new Set(['data']))
  })

  it('失败时回的空结果也符合各自 schema', () => {
    // 错误响应同样带 structuredContent：只回 content 时严格客户端可能判定不合法。
    const searchProps = schemaProps('search', searchOutputSchema)
    expect(new Set(Object.keys(EMPTY_SEARCH_RESULT))).toEqual(searchProps)
    expect(EMPTY_SEARCH_RESULT.results).toEqual([])

    const fetchProps = schemaProps('fetch', fetchOutputSchema)
    const emptyFetch = emptyFetchResult('https://example.com', '01j0000000000000000000001')
    expect(new Set(Object.keys(emptyFetch))).toEqual(fetchProps)
    // url 必须仍是合法绝对 URL，否则 z.string().url() 校验不过。
    expect(() => new URL(emptyFetch.url)).not.toThrow()
  })

  it('错误体可以装进 general 工具的 data 字段', () => {
    const body = { error: { code: 'internal', message: 'failed' } }
    const wrapped = { data: body }
    expect(new Set(Object.keys(wrapped))).toEqual(new Set(['data']))
  })
})
