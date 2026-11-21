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
): Promise<AiNoteSummaryResponse> {
  const [usage, hash, draft] = await Promise.all([
    readUsage(db, userId),
    row ? summarySourceHash(note.title, note.content) : Promise.resolve(null),
    loadDraft(db, userId, note.id),
  ])
  return {
    summary: row ? toAiSummary(row, hash ?? undefined) : null,
    /** 待确认草稿：正文受影响时由自动更新生成，需用户确认后才替换正式摘要。 */
    draft: draft
      ? { text: draft.draft_text, operation: draft.operation, createdAt: draft.created_at }
      : null,
    minimumCharacters: LIMITS.aiSummaryMinChars,
    characterCount: countSummaryCharacters(note.content),
    remainingNeurons: remainingNeurons(usage.neurons),
  }
}

summaryRoutes.get('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  const row = await loadSummary(c.env.DB, userId, note.id)
  return c.json(await summaryResponse(c.env.DB, userId, note, row))
})

summaryRoutes.post('/:id/summary', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  // 100 字门槛只约束自动流程；手动点击允许短笔记，但不能是空笔记。
  if (countSummaryCharacters(note.content) === 0) {
    throw ApiError.badRequest('This note has no content to summarize')
  }

  const ai = c.env.AI
  const provider = ai ? createWorkersAiProvider(ai) : null
  const outcome = await generateSummary({
    db: c.env.DB,
    provider,
    userId,
    note,
    locale: userLocale(c.get('user').settingsRaw),
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

  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id)))
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
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id)))
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
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id)))
})

summaryRoutes.delete('/:id/summary/draft', async (c) => {
  const userId = c.get('userId')
  const note = await loadNoteForSummary(c.env.DB, userId, c.req.param('id'))
  await deleteDraft(c.env.DB, userId, note.id)
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id)))
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
  return c.json(await summaryResponse(c.env.DB, userId, note, await loadSummary(c.env.DB, userId, note.id)))
})
