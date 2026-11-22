import { Hono } from 'hono'
import { LIMITS, mergeSettings } from '@shared/constants'
import { countSummaryCharacters } from '@shared/markdown-utils'
import type { AiNoteSummaryResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  generateSummary,
  loadSummary,
  saveUserSummary,
  summarySourceHash,
  toAiSummary,
  type SummaryRow,
} from '../summary/service'
import { acceptDraft, deleteDraft, listVersions, loadDraft, restoreVersion } from '../summary/drafts'
import { resolveSummaryPolicy, setNoteFlags } from '../summary/policy'
import { purgeAiSummary, purgeNoteSummary } from '../summary/purge'
import { dropQueuedSummary } from '../summary/queue'
import { createWorkersAiProvider } from '../summary/workers-ai'
import { readUsage, remainingNeurons } from '../summary/usage'

export const summaryRoutes = new Hono<AppBindings>()

summaryRoutes.use('*', requireAuth)

interface NoteRow {
  id: string
  title: string
  content: string
  user_id: string
}

async function loadNoteForSummary(db: D1Database, userId: string, noteId: string): Promise<NoteRow> {
  const row = await db
    .prepare(`SELECT id, user_id, title, content FROM notes WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(noteId)
    .first<NoteRow>()
  if (!row || row.user_id !== userId) throw ApiError.notFound()
  return row
}

function userLocale(settingsRaw: string): string {
  try {
    return mergeSettings(JSON.parse(settingsRaw)).appearance.language
  } catch {
    return 'zh-CN'
  }
}

async function summaryResponse(
  db: D1Database,
  userId: string,
  note: { id: string; title: string; content: string },
  row: SummaryRow | null,
  settingsRaw: string,
): Promise<AiNoteSummaryResponse> {
  const [usage, hash, draft, policy] = await Promise.all([
    readUsage(db, userId),
    row ? summarySourceHash(note.title, note.content) : Promise.resolve(null),
    loadDraft(db, userId, note.id),
    resolveSummaryPolicy({ db, userId, noteId: note.id, settingsRaw, hasSummary: Boolean(row) }),
  ])
  return {
    summary: row ? toAiSummary(row, hash ?? undefined) : null,
    draft: draft
      ? { text: draft.draft_text, operation: draft.operation, createdAt: draft.created_at }
      : null,
    draftMode: draft ? (draft.operation === 'refine' ? 'refine' : 'fresh') : undefined,
    minimumCharacters: LIMITS.aiSummaryMinChars,
    characterCount: countSummaryCharacters(note.content),
    remainingNeurons: remainingNeurons(usage.neurons),
    visible: policy.visible,
    canGenerate: policy.canGenerate,
    autoEligible: policy.autoEligible,
    settings: {
      summaryEnabled: policy.summaryEnabled,
      aiMode: policy.aiMode,
      autoGenerate: policy.autoGenerate,
    },
  }
}

summaryRoutes.get('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const row = await loadSummary(c.env.DB, userId, note.id)
  return c.json(await summaryResponse(c.env.DB, userId, note, row, c.get('user').settingsRaw))
})

summaryRoutes.put('/:id/summary/settings', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const body = await readJson<{
    summaryEnabled?: boolean | null
    aiMode?: string
    autoGenerate?: boolean | null
  }>(c, JSON_BODY_LIMITS.small)

  if (body.aiMode !== undefined && body.aiMode !== 'inherit' && body.aiMode !== 'enabled' && body.aiMode !== 'disabled') {
    throw ApiError.badRequest('aiMode must be inherit, enabled or disabled')
  }
  if (body.summaryEnabled !== undefined && body.summaryEnabled !== null && typeof body.summaryEnabled !== 'boolean') {
    throw ApiError.badRequest('summaryEnabled must be a boolean or null')
  }
  if (body.autoGenerate !== undefined && body.autoGenerate !== null && typeof body.autoGenerate !== 'boolean') {
    throw ApiError.badRequest('autoGenerate must be a boolean or null')
  }

  await setNoteFlags(c.env.DB, userId, note.id, {
    ...(body.summaryEnabled !== undefined ? { summaryEnabled: body.summaryEnabled } : {}),
    ...(body.aiMode !== undefined ? { aiMode: body.aiMode as 'inherit' | 'enabled' | 'disabled' } : {}),
    ...(body.autoGenerate !== undefined ? { autoGenerate: body.autoGenerate } : {}),
  })

  // 关闭摘要 = 这篇彻底不要了：内容、草稿、历史、任务全部删除。
  if (body.summaryEnabled === false) {
    await purgeNoteSummary(c.env.DB, userId, note.id)
  } else if (body.aiMode === 'disabled') {
    // 关闭 AI = 只删 AI 生成的；手写摘要与历史保留。
    await purgeAiSummary(c.env.DB, userId, note.id)
  }
  if (body.autoGenerate === false) await dropQueuedSummary(c.env.DB, userId, note.id).catch(() => undefined)

  const row = await loadSummary(c.env.DB, userId, note.id)
  return c.json(await summaryResponse(c.env.DB, userId, note, row, c.get('user').settingsRaw))
})

summaryRoutes.post('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const existing = await loadSummary(c.env.DB, userId, note.id)
  const policy = await resolveSummaryPolicy({
    db: c.env.DB,
    userId,
    noteId: note.id,
    settingsRaw: c.get('user').settingsRaw,
    hasSummary: Boolean(existing),
  })
  if (!policy.canGenerate) {
    throw new ApiError(503, 'ai_unavailable', 'AI summaries are disabled for this note or account')
  }
  // 100 字门槛只约束自动流程；手动点击允许短笔记，但不能是空笔记。
  if (countSummaryCharacters(note.content) === 0) {
    throw ApiError.badRequest('This note has no content to summarize')
  }

  const ai = c.env.AI
  const provider = ai ? createWorkersAiProvider(ai) : null
  const body = await readJson<{ mode?: string; instruction?: string }>(c, JSON_BODY_LIMITS.small).catch(
    (): { mode?: string; instruction?: string } => ({}),
  )
  const mode = body.mode === 'refine' ? 'refine' : body.mode === 'fresh' ? 'fresh' : undefined
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 500) : undefined
  const outcome = await generateSummary({
    db: c.env.DB,
    provider,
    userId,
    note,
    locale: userLocale(c.get('user').settingsRaw),
    // 智能生成才需要确认：已有摘要时不直接覆盖，先给草稿。
    asDraft: Boolean(mode) && Boolean(existing),
    mode,
    instruction,
  })

  if (!outcome.ok) {
    switch (outcome.code) {
      case 'ai_unavailable':
        throw new ApiError(503, 'ai_unavailable', 'AI summaries are not configured for this instance')
      case 'quota_exhausted':
        throw new ApiError(429, 'ai_quota_exhausted', 'Daily AI summary quota is exhausted')
      case 'truncated':
        throw new ApiError(502, 'ai_failed', 'The AI response was cut off; please try again')
      default:
        throw new ApiError(502, 'ai_failed', 'The AI service did not return a usable summary')
    }
  }

  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id), c.get('user').settingsRaw))
})

summaryRoutes.patch('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const body = await readJson<{ text?: string }>(c, JSON_BODY_LIMITS.note)
  if (typeof body.text !== 'string') throw ApiError.badRequest('text must be a string')

  const text = body.text.trim()
  if (!text) throw ApiError.badRequest('Summary text cannot be empty')
  if (text.length > LIMITS.aiSummaryMaxChars) throw ApiError.badRequest('Summary text is too long')

  await saveUserSummary({
    db: c.env.DB,
    userId,
    note,
    text,
    locale: userLocale(c.get('user').settingsRaw),
  })
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id), c.get('user').settingsRaw))
})

summaryRoutes.delete('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  await c.env.DB
    .prepare(`DELETE FROM note_summaries WHERE note_id = ?1 AND user_id = ?2`)
    .bind(note.id, userId)
    .run()
  return c.json({ ok: true as const })
})

summaryRoutes.post('/:id/summary/draft/accept', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const result = await acceptDraft({
    db: c.env.DB,
    userId,
    noteId: note.id,
    currentSourceHash: await summarySourceHash(note.title, note.content),
  })
  if (!result.ok) throw ApiError.notFound('No draft to accept')
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id), c.get('user').settingsRaw))
})

summaryRoutes.delete('/:id/summary/draft', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  await deleteDraft(c.env.DB, userId, note.id)
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id), c.get('user').settingsRaw))
})

summaryRoutes.get('/:id/summary/versions', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const versions = await listVersions(c.env.DB, userId, note.id)
  return c.json({
    versions: versions.map((version) => ({
      id: version.id,
      text: version.summary_text,
      origin: version.summary_origin === 'user' ? 'user' : 'ai',
      operation: version.operation,
      createdAt: version.created_at,
    })),
  })
})

summaryRoutes.post('/:id/summary/versions/:versionId/restore', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const result = await restoreVersion({
    db: c.env.DB,
    userId,
    noteId: note.id,
    versionId: c.req.param('versionId'),
    currentSourceHash: await summarySourceHash(note.title, note.content),
    language: userLocale(c.get('user').settingsRaw),
  })
  if (!result.ok) throw ApiError.notFound('Version not found')
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id), c.get('user').settingsRaw))
})
