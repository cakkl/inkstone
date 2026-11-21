/** 摘要生成的统一入口；替换模型或供应商时只改这一层。 */
export type SummaryLength = 'short' | 'medium' | 'long'

export interface SummaryRequest {
  title: string
  content: string
  language: string
  length: SummaryLength
}

export interface SummaryResult {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
  neurons: number
  /** 模型因输出上限被截断时为 true；调用方必须拒绝入库。 */
  truncated: boolean
}

export interface SummaryProvider {
  generate(request: SummaryRequest): Promise<SummaryResult>
}

/** 失败时抛出该错误，调用方据此区分「模型不可用」与「摘要内容有问题」。 */
export class SummaryProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SummaryProviderError'
  }
}
