/** 摘要生成的统一入口；替换模型或供应商时只改这一层。 */
export type SummaryLength = 'short' | 'medium' | 'long'

export interface SummaryRequest {
  title: string
  content: string
  language: string
  length: SummaryLength
  /** 传入时走补充式：以旧摘要为口径参考，正文为准。 */
  previousSummary?: string
  /** 用户在智能生成里写的补充要求。 */
  instruction?: string
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
