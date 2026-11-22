import type { Context } from 'hono'
import type { ApiErrorCode } from '@shared/types'

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details)
  }
  static unauthenticated(message = "Please sign in first") {
    return new ApiError(401, 'unauthenticated', message)
  }
  static forbidden(message = 'Permission denied') {
    return new ApiError(403, 'forbidden', message)
  }
  static notFound(message = 'Content not found', details?: unknown) {
    return new ApiError(404, 'not_found', message, details)
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, details)
  }
  static tooLarge(message: string) {
    return new ApiError(413, 'payload_too_large', message)
  }
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      err.status,
    )
  }
  console.error('[inkstone] Unhandled error:', err)
  // D1 等运行时错误常没有 message，前一条日志无法定位；这里补结构化字段（含 cause）。
  console.error('[inkstone] Unhandled error detail:', describeUnknownError(err))

  return c.json({ error: { code: 'internal', message: "Internal server error" } }, 500)
}

function describeUnknownError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : err.cause,
    }
  }
  if (typeof err === 'string') return { value: err }
  try {
    return { value: JSON.stringify(err) }
  } catch {
    return { value: String(err) }
  }
}
