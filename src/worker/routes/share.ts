import { Hono, type Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import type { PublicNote, ShareEmbed, ShareInfo, ShareListItem } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug, newSlug } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson, requestClientIp } from '../lib/request'
import { hashPassword, verifyPassword } from '../lib/password'
import { resolveShareLinks, resolveShareTarget } from '../lib/share-links'
import {
  createShareAssetSession,
  shareAssetCookieName,
} from '../lib/share-asset-session'
import {
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  ThrottleError,
} from '../lib/throttle'
import { requireAuth } from '../middleware/auth'


export const shareManageRoutes = new Hono<AppBindings>()

export const shareRoutes = new Hono<AppBindings>()

export const sharePageRoutes = new Hono<AppBindings>()

interface ShareRow {
  slug: string
  note_id: string
  user_id: string
  password_hash: string | null
  expires_at: number | null
  views: number
  created_at: number
  include_summary: number
}

function toShareInfo(row: ShareRow, origin: string): ShareInfo {
  return {
    slug: row.slug,
    noteId: row.note_id,
    url: `${origin}/s/${row.slug}`,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    views: row.views,
    createdAt: row.created_at,
    includeSummary: row.include_summary !== 0,
  }
}


shareManageRoutes.use('*', requireAuth)

shareManageRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.slug, s.note_id, s.user_id, s.password_hash, s.expires_at, s.views, s.created_at,
            s.include_summary,
            n.title AS note_title, n.deleted_at
       FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
      WHERE s.user_id = ?1
      ORDER BY s.created_at DESC, s.slug DESC`,
  ).bind(c.get('userId')).all<ShareRow & { note_title: string; deleted_at: number | null }>()
  const origin = new URL(c.req.url).origin
  const shares: ShareListItem[] = rows.results.map((row) => ({
    ...toShareInfo(row, origin),
    noteTitle: row.note_title,
    deletedAt: row.deleted_at,
  }))
  return c.json({ shares })
})

shareManageRoutes.get('/:noteId', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM shares WHERE note_id = ?1 AND user_id = ?2`,
  )
    .bind(c.req.param('noteId'), c.get('userId'))
    .first<ShareRow>()
  if (!row) return c.json({ share: null })
  return c.json({ share: toShareInfo(row, new URL(c.req.url).origin) })
})

shareManageRoutes.post('/:noteId', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('noteId')
  const body = await readJson<{
    password?: string | null
    expiresIn?: number | null
    includeSummary?: boolean
  }>(c, JSON_BODY_LIMITS.small)

  const note = await c.env.DB.prepare(
    `SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(noteId, userId)
    .first<{ id: string }>()
  if (!note) throw ApiError.notFound('Note not found')

  const slug = newSlug()
  if (body.password !== undefined && body.password !== null && typeof body.password !== 'string') {
    throw ApiError.badRequest('password must be a string or null')
  }
  if (typeof body.password === 'string' && body.password.length > LIMITS.passwordMaxLength) {
    throw ApiError.badRequest(`The access password must not exceed ${LIMITS.passwordMaxLength} characters`)
  }
  if (typeof body.password === 'string' && body.password.length > 0 && body.password.length < 4) {
    throw ApiError.badRequest('The access password must be at least 4 characters')
  }
  if (
    body.expiresIn !== undefined &&
    body.expiresIn !== null &&
    (!Number.isFinite(body.expiresIn) || body.expiresIn < 0)
  ) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  if (body.includeSummary !== undefined && typeof body.includeSummary !== 'boolean') {
    throw ApiError.badRequest('includeSummary must be a boolean')
  }
  const expiresAt =
    typeof body.expiresIn === 'number' && body.expiresIn > 0
        ? Date.now() + Math.min(body.expiresIn, 365 * 24 * 60 * 60 * 1000)
        : null

  const replacePassword = body.password === null || typeof body.password === 'string'
  const passwordHash =
    body.password === null
      ? null
      : typeof body.password === 'string' && body.password
        ? await hashPassword(body.password)
        : null

  const written = await c.env.DB.prepare(
    `INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at, include_summary)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?9)
     ON CONFLICT(note_id) DO UPDATE SET
       password_hash = CASE WHEN ?7 = 1 THEN excluded.password_hash ELSE shares.password_hash END,
       expires_at = CASE WHEN ?8 = 1 THEN excluded.expires_at ELSE shares.expires_at END,
       include_summary = excluded.include_summary
     WHERE shares.user_id = excluded.user_id`,
  )
    .bind(
      slug,
      noteId,
      userId,
      passwordHash,
      expiresAt,
      Date.now(),
      replacePassword ? 1 : 0,
      body.expiresIn !== undefined ? 1 : 0,
      body.includeSummary === false ? 0 : 1,
    )
    .run()
  if (!written.meta.changes) throw new ApiError(409, 'conflict', 'Share state changed. Refresh and try again')

  const row = await c.env.DB.prepare(`SELECT * FROM shares WHERE note_id = ?1 AND user_id = ?2`)
    .bind(noteId, userId)
    .first<ShareRow>()
  return c.json({ share: toShareInfo(row!, new URL(c.req.url).origin) })
})

shareManageRoutes.delete('/:noteId', async (c) => {
  const noteId = c.req.param('noteId')
  const userId = c.get('userId')
  await c.env.DB.prepare(`DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2`)
    .bind(noteId, userId)
    .run()
  return c.json({ ok: true })
})


shareRoutes.post('/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) throw ApiError.notFound('The link does not exist or has been revoked')
  const body = await readOptionalJson<{ password?: string }>(c, JSON_BODY_LIMITS.small, {})
  const password = typeof body.password === 'string'
    ? body.password.slice(0, LIMITS.passwordMaxLength)
    : ''

  const share = await c.env.DB.prepare(`SELECT * FROM shares WHERE slug = ?1`)
    .bind(slug)
    .first<ShareRow>()
  if (!share) throw ApiError.notFound('The link does not exist or has been revoked')
  if (share.expires_at && share.expires_at < Date.now()) throw ApiError.notFound('The link has expired')

  if (share.password_hash) {
    const denied = await checkSharePassword(c, slug, share.password_hash, password)
    if (denied) return denied
  }

  const note = await c.env.DB.prepare(
    `SELECT n.title, n.content, n.created_at, n.updated_at, u.name, u.avatar_url
       FROM notes n JOIN users u ON u.id = n.user_id
      WHERE n.id = ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL`,
  )
    .bind(share.note_id, share.user_id)
    .first<{
      title: string
      content: string
      created_at: number
      updated_at: number
      name: string
      avatar_url: string
    }>()
  if (!note) throw ApiError.notFound('The note has been deleted')

  c.executionCtx?.waitUntil(
    c.env.DB.prepare(`UPDATE shares SET views = views + 1 WHERE slug = ?1`).bind(slug).run().catch(() => {}),
  )

  let rootUnlock: string | null = null
  if (share.password_hash) {
    rootUnlock = await issueShareAssetSession(c, slug, share.password_hash, share.expires_at)
  }

  // 只在分享者开启时读取摘要，避免无谓查询与误外发。
  const summary = share.include_summary
    ? await c.env.DB.prepare(
      `SELECT summary_text, updated_at FROM note_summaries WHERE note_id = ?1 AND user_id = ?2`,
    )
      .bind(share.note_id, share.user_id)
      .first<{ summary_text: string; updated_at: number }>()
    : null

  const links = await resolveShareLinks(c.env.DB, share.user_id, share.note_id)
  const body_: PublicNote = {
    title: note.title,
    content: note.content,
    summary: summary ? { text: summary.summary_text, updatedAt: summary.updated_at } : null,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    author: { name: note.name, avatarUrl: note.avatar_url },
    site: { name: c.env.APP_NAME || 'Inkstone' },
    share: { slug },
    links,
    ...(rootUnlock ? { unlocks: [{ slug, token: rootUnlock }] } : {}),
  }
  return c.json(body_)
})

/** 单次嵌入响应的服务端硬上限，客户端另有总字符上限。 */
const EMBED_MAX_CHARS = 200_000

shareRoutes.post('/:slug/embed', async (c) => {
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) throw ApiError.notFound('The link does not exist or has been revoked')
  const body = await readOptionalJson<{
    key?: string
    password?: string
    unlocks?: unknown
  }>(c, JSON_BODY_LIMITS.small, {})
  const key = typeof body.key === 'string' ? body.key.trim().slice(0, 400) : ''
  if (!key) throw ApiError.badRequest('key is required')
  const password = typeof body.password === 'string'
    ? body.password.slice(0, LIMITS.passwordMaxLength)
    : ''
  const unlocks = parseUnlocks(body.unlocks)

  // 轻量配额：防止把展开接口当作逐 key 探测工具。
  try {
    await consumeAttemptBudget(c.env.DB, [{
      key: `share-embed:ip:${requestClientIp(c)}`,
      maxAttempts: 60,
      windowMs: 60 * 1000,
    }])
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, {
        retryAfter: err.retryAfterSec,
      })
    }
    throw err
  }

  // 目标必须在「从本分享出发、每一跳都已解锁」的链上；未公开/已过期/未解锁的一律 404。
  const target = await resolveShareTarget(c.env.DB, slug, key, (nodeSlug) => unlocks.get(nodeSlug))
  if (!target) throw ApiError.notFound('The linked note is not shared')

  let targetUnlock: string | null = null
  if (target.passwordHash) {
    const denied = await checkSharePassword(c, target.shareSlug, target.passwordHash, password)
    if (denied) return denied
    targetUnlock = await issueShareAssetSession(c, target.shareSlug, target.passwordHash, null)
  }

  const note = await c.env.DB.prepare(
    `SELECT title, content FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(target.noteId, target.userId).first<{ title: string; content: string }>()
  if (!note) throw ApiError.notFound('The note has been deleted')
  if (note.content.length > EMBED_MAX_CHARS) {
    return c.json({
      error: { code: 'content_too_large', message: 'The embedded note is too large to render inline' },
    }, 413)
  }

  const links = await resolveShareLinks(c.env.DB, target.userId, target.noteId)
  const payload: ShareEmbed = {
    key,
    state: target.passwordHash ? 'password' : 'shared',
    slug: target.shareSlug,
    title: note.title,
    content: note.content,
    links,
    ...(targetUnlock ? { unlocks: [{ slug: target.shareSlug, token: targetUnlock }] } : {}),
  }
  return c.json(payload)
})

/** 校验分享口令；失败时返回要直接回给客户端的响应。限流与失败记账与 /api/public/:slug 共用。 */
async function checkSharePassword(
  c: Context<AppBindings>,
  slug: string,
  passwordHash: string,
  password: string,
): Promise<Response | null> {
  if (!password) {
    return c.json({ error: { code: 'password_required', message: 'An access password is required' } }, 401)
  }
  const throttleKeys = [
    `share:${slug}:ip:${requestClientIp(c)}`,
    { key: `share-slug:${slug}`, freeFails: 40 },
  ]
  const workKeys = [
    {
      key: `share-work:${slug}:ip:${requestClientIp(c)}`,
      maxAttempts: 8,
      windowMs: 10 * 60 * 1000,
    },
    {
      key: `share-work-slug:${slug}`,
      maxAttempts: 60,
      windowMs: 10 * 60 * 1000,
    },
  ]
  try {
    await consumeAttemptBudget(c.env.DB, workKeys)
    await assertNotLocked(c.env.DB, throttleKeys)
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', `Too many attempts. Try again in ${err.retryAfterSec} seconds`, {
        retryAfter: err.retryAfterSec,
      })
    }
    throw err
  }
  if (!(await verifyPassword(password, passwordHash))) {
    await recordLoginFailure(c.env.DB, throttleKeys)
    return c.json({ error: { code: 'password_invalid', message: 'Incorrect passcode' } }, 401)
  }
  await clearLoginFailures(c.env.DB, [...throttleKeys, ...workKeys.map((target) => target.key)])
  return null
}

/** 口令通过后签发附件会话（并写 cookie），返回给客户端在后续嵌入请求里回传。 */
async function issueShareAssetSession(
  c: Context<AppBindings>,
  slug: string,
  passwordHash: string,
  expiresAt: number | null,
): Promise<string> {
  const until = Math.min(expiresAt ?? Number.MAX_SAFE_INTEGER, Date.now() + 12 * 60 * 60 * 1000)
  const token = await createShareAssetSession(c.env.DB, slug, passwordHash, until)
  setCookie(c, shareAssetCookieName(slug), token, {
    path: '/api/files/',
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: Math.max(1, Math.floor((until - Date.now()) / 1000)),
    secure: new URL(c.req.url).protocol === 'https:',
  })
  return token
}

/** 客户端回传的口令会话凭证：最多 8 条，slug 与 token 都做合法性校验。 */
function parseUnlocks(value: unknown): Map<string, string> {
  const unlocks = new Map<string, string>()
  if (!Array.isArray(value)) return unlocks
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const slug = (item as { slug?: unknown }).slug
    const token = (item as { token?: unknown }).token
    if (typeof slug === 'string' && isValidSlug(slug) && typeof token === 'string' && token.length <= 128) {
      unlocks.set(slug, token)
    }
  }
  return unlocks
}


sharePageRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const url = new URL(c.req.url)

  if (!isValidSlug(slug)) {
    return renderShareShell(c, url, null)
  }

  const row = await c.env.DB.prepare(
    `SELECT s.password_hash, s.expires_at, n.title, n.excerpt
       FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
      WHERE s.slug = ?1 AND n.deleted_at IS NULL`,
  )
    .bind(slug)
    .first<{ password_hash: string | null; expires_at: number | null; title: string; excerpt: string }>()

  return renderShareShell(c, url, row)
})

async function renderShareShell(
  c: Context<AppBindings>,
  url: URL,
  row: { password_hash: string | null; expires_at: number | null; title: string; excerpt: string } | null,
) {
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell
  let html = await shell.text()

  const siteName = c.env.APP_NAME || 'Inkstone'
  const expired = row?.expires_at ? row.expires_at < Date.now() : false
  const title = row && !expired && !row.password_hash ? publicShareTitle(row.title) : "Content unavailable"
  const description = row && !expired && !row.password_hash ? row.excerpt : ''

  const meta = [
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    description ? `<meta property="og:description" content="${escapeHtml(description)}" />` : '',
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ]
    .filter(Boolean)
    .join('\n    ')

  html = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', `    ${meta}\n  </head>`)

  return c.html(html, 200, {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
}

export function publicShareTitle(title: string): string {
  return title || 'Untitled note'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
