// @vitest-environment node
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, errorResponse, isTransientStorageError } from '../src/worker/lib/errors'

function appWith(error: unknown): Hono {
  const app = new Hono()
  app.get('/boom', () => {
    throw error
  })
  app.onError((err, c) => errorResponse(c, err))
  return app
}

describe('isTransientStorageError', () => {
  it('识别跨请求 promise 与请求取消', () => {
    expect(isTransientStorageError(new Error(
      'This promise was created by a request that has since ended, so it can never settle.',
    ))).toBe(true)
    expect(isTransientStorageError('The Workers runtime canceled this request.')).toBe(true)
  })

  it('普通错误与业务错误不算瞬时故障', () => {
    expect(isTransientStorageError(new Error('too many SQL variables'))).toBe(false)
    expect(isTransientStorageError(ApiError.notFound())).toBe(false)
    expect(isTransientStorageError(null)).toBe(false)
  })
})

describe('errorResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('跨请求 promise 错误映射为 503 storage_unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith(new Error(
      'This promise was created by a request that has since ended, so it can never settle.',
    )).request('/boom')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: 'storage_unavailable', message: 'Storage is temporarily unavailable' },
    })
  })

  it('未知错误仍返回 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith(new Error('boom')).request('/boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    })
  })
})
