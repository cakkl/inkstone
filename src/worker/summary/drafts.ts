import type { AiSummaryOrigin } from '@shared/types'
import { newId } from '../lib/id'
import { loadSummary, type SummaryRow } from './service'

export interface DraftRow {
  note_id: string
  draft_text: string
  operation: string
  base_updated_at: number | null
  model: string | null
  created_at: number
}

export interface VersionRow {
  id: string
  summary_text: string
  summary_origin: string
  summary_language: string
  source_hash: string
  operation: string
  created_at: number
}

/** 每篇笔记一条：新草稿覆盖旧的，正式摘要不受影响。 */
export async function saveDraft(
  db: D1Database,
  input: {
    userId: string
    noteId: string
    text: string
    operation: string
    sourceHash: string
    baseUpdatedAt: number | null
    model: string | null
    promptVersion: string | null
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO note_summary_drafts
         (note_id, user_id, draft_text, operation, source_hash, base_updated_at,
          model, prompt_version, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(note_id) DO UPDATE SET
         draft_text = excluded.draft_text,
         operation = excluded.operation,
         source_hash = excluded.source_hash,
         base_updated_at = excluded.base_updated_at,
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         created_at = excluded.created_at
       WHERE note_summary_drafts.user_id = excluded.user_id`,
    )
    .bind(
      input.noteId,
      input.userId,
      input.text,
      input.operation,
      input.sourceHash,
      input.baseUpdatedAt,
      input.model,
      input.promptVersion,
      Date.now(),
    )
    .run()
}

export async function loadDraft(db: D1Database, userId: string, noteId: string): Promise<DraftRow | null> {
  return db
    .prepare(
      `SELECT note_id, draft_text, operation, base_updated_at, model, created_at
         FROM note_summary_drafts WHERE note_id = ?1 AND user_id = ?2`,
    )
    .bind(noteId, userId)
    .first<DraftRow>()
}

export async function deleteDraft(db: D1Database, userId: string, noteId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM note_summary_drafts WHERE note_id = ?1 AND user_id = ?2`)
    .bind(noteId, userId)
    .run()
}

/** 每次正式摘要变化前存旧值，便于回滚。 */
export async function pushVersion(
  db: D1Database,
  userId: string,
  previous: SummaryRow,
  operation: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO note_summary_versions
         (id, note_id, user_id, summary_text, summary_origin, summary_language, source_hash, operation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      newId(),
      previous.note_id,
      userId,
      previous.summary_text,
      previous.summary_origin,
      previous.summary_language,
      previous.source_hash,
      operation,
      Date.now(),
    )
    .run()
}

export async function listVersions(
  db: D1Database,
  userId: string,
  noteId: string,
  limit = 20,
): Promise<VersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, summary_text, summary_origin, summary_language, source_hash, operation, created_at
         FROM note_summary_versions
        WHERE note_id = ?1 AND user_id = ?2
        ORDER BY created_at DESC, id DESC
        LIMIT ?3`,
    )
    .bind(noteId, userId, limit)
    .all<VersionRow>()
  return results
}

export async function loadVersion(
  db: D1Database,
  userId: string,
  noteId: string,
  versionId: string,
): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT id, summary_text, summary_origin, summary_language, source_hash, operation, created_at
         FROM note_summary_versions
        WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
    )
    .bind(versionId, noteId, userId)
    .first<VersionRow>()
}

/**
 * 接受草稿：当前摘要先进历史，再写入草稿内容，最后删除草稿。
 * 指纹按当前正文重算，避免接受后立刻显示「已过期」。
 */
export async function acceptDraft(input: {
  db: D1Database
  userId: string
  noteId: string
  currentSourceHash: string
}): Promise<{ ok: true } | { ok: false; reason: 'missing_draft' }> {
  const draft = await loadDraft(input.db, input.userId, input.noteId)
  if (!draft) return { ok: false, reason: 'missing_draft' }

  const existing = await loadSummary(input.db, input.userId, input.noteId)
  if (existing) await pushVersion(input.db, input.userId, existing, `accept:${draft.operation}`)

  const now = Date.now()
  const origin: AiSummaryOrigin = existing?.summary_origin === 'user' ? 'user' : 'ai'
  await input.db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'current', ?7, ?8, ?9, ?9)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = excluded.summary_origin,
         source_hash = excluded.source_hash,
         summary_status = 'current',
         model = excluded.model,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at
       WHERE note_summaries.user_id = excluded.user_id`,
    )
    .bind(
      input.noteId,
      input.userId,
      draft.draft_text,
      origin,
      existing?.summary_language ?? 'zh-CN',
      input.currentSourceHash,
      draft.model,
      null,
      now,
    )
    .run()

  await deleteDraft(input.db, input.userId, input.noteId)
  return { ok: true }
}

/** 恢复历史版本：当前摘要先进历史，再写入选中的旧值。 */
export async function restoreVersion(input: {
  db: D1Database
  userId: string
  noteId: string
  versionId: string
  currentSourceHash: string
  language: string
}): Promise<{ ok: true } | { ok: false; reason: 'missing_version' }> {
  const version = await loadVersion(input.db, input.userId, input.noteId, input.versionId)
  if (!version) return { ok: false, reason: 'missing_version' }

  const existing = await loadSummary(input.db, input.userId, input.noteId)
  if (existing) await pushVersion(input.db, input.userId, existing, 'restore')

  const now = Date.now()
  await input.db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'current', NULL, NULL, ?7, ?7)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = excluded.summary_origin,
         summary_language = excluded.summary_language,
         source_hash = excluded.source_hash,
         summary_status = 'current',
         model = NULL,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at
       WHERE note_summaries.user_id = excluded.user_id`,
    )
    .bind(
      input.noteId,
      input.userId,
      version.summary_text,
      version.summary_origin,
      version.summary_language || input.language,
      input.currentSourceHash,
      now,
    )
    .run()
  return { ok: true }
}
