import { LIMITS } from '@shared/constants'
import { summarySourceHash } from './service'

export interface SummaryRestoreEntry {
  noteId: string
  text: string
  origin: 'user' | 'ai'
  language: string
  model: string | null
  evolved: boolean
  refineCount: number
  generatedAt: number
  updatedAt: number
}

/** 恢复摘要（备份 / 结构化导出共用）：已有摘要不覆盖，指纹按恢复后的正文重算。 */
export async function restoreSummaries(input: {
  db: D1Database
  userId: string
  entries: readonly SummaryRestoreEntry[]
  resolveNoteId: (sourceId: string) => Promise<string | null> | string | null
}): Promise<number> {
  const { db, userId } = input
  if (input.entries.length === 0) return 0
  let restored = 0

  for (const entry of input.entries) {
    if (!isRestorableEntry(entry)) continue
    const targetId = await input.resolveNoteId(entry.noteId)
    if (!targetId) continue

    const note = await db
      .prepare(`SELECT title, content FROM notes WHERE id = ?1 AND user_id = ?2`)
      .bind(targetId, userId)
      .first<{ title: string; content: string }>()
    if (!note) continue

    const sourceHash = await summarySourceHash(note.title, note.content)
    const now = Date.now()
    const generatedAt = Math.min(entry.generatedAt, now)
    const updatedAt = Math.min(Math.max(entry.updatedAt, generatedAt), now)
    await db
      .prepare(
        `INSERT INTO note_summaries
           (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
            summary_status, model, prompt_version, generated_at, updated_at,
            summary_evolved, refine_count, last_fresh_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'current', ?7, NULL, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(note_id) DO NOTHING`,
      )
      .bind(
        targetId,
        userId,
        entry.text,
        entry.origin,
        entry.language,
        sourceHash,
        entry.model,
        generatedAt,
        updatedAt,
        entry.evolved ? 1 : 0,
        entry.refineCount,
        entry.evolved ? null : generatedAt,
      )
      .run()
    restored += 1
  }

  return restored
}

function isRestorableEntry(entry: SummaryRestoreEntry): boolean {
  if (!entry.noteId) return false
  if (!entry.text || entry.text.length > LIMITS.aiSummaryMaxChars) return false
  if (entry.origin !== 'user' && entry.origin !== 'ai') return false
  if (!entry.language || entry.language.length > 16) return false
  if (entry.model !== null && (typeof entry.model !== 'string' || entry.model.length > 64)) return false
  if (!Number.isSafeInteger(entry.refineCount) || entry.refineCount < 0) return false
  if (!Number.isSafeInteger(entry.generatedAt) || entry.generatedAt <= 0) return false
  return Number.isSafeInteger(entry.updatedAt) && entry.updatedAt > 0
}
