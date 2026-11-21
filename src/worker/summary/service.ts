import { LIMITS } from '@shared/constants'
import type { AiNoteSummary } from '@shared/types'
import { sha256Hex } from '../lib/encoding'
import { SummaryProviderError, type SummaryLength, type SummaryProvider } from './provider'
import { PROMPT_VERSION, SUMMARY_MODEL } from './workers-ai'
import { readUsage, remainingNeurons, recordUsage, utcDateKey } from './usage'

export interface SummaryRow {
  note_id: string
  summary_text: string
  summary_origin: string
  summary_status: string
  summary_language: string
  source_hash: string
  model: string | null
  generated_at: number | null
  updated_at: number
}

export function toAiSummary(row: SummaryRow, currentSourceHash?: string): AiNoteSummary {
  // 正文指纹不一致就是过期：不依赖写入路径是否记得去改状态列。
  const stale = row.summary_status === 'outdated' ||
    (currentSourceHash !== undefined && row.source_hash !== currentSourceHash)
  return {
    noteId: row.note_id,
    text: row.summary_text,
    origin: row.summary_origin === 'user' ? 'user' : 'ai',
    status: stale ? 'outdated' : 'current',
    language: row.summary_language,
    model: row.model,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  }
}

/** 正文指纹：判断摘要在生成后是否已过期。 */
export function summarySourceHash(title: string, content: string): Promise<string> {
  return sha256Hex(`${title}\u0000${content}`)
}

export async function loadSummary(db: D1Database, userId: string, noteId: string): Promise<SummaryRow | null> {
  return db
    .prepare(
      `SELECT note_id, summary_text, summary_origin, summary_status, summary_language,
              source_hash, model, generated_at, updated_at
         FROM note_summaries WHERE note_id = ?1 AND user_id = ?2`,
    )
    .bind(noteId, userId)
    .first<SummaryRow>()
}

export interface GenerateSummaryInput {
  db: D1Database
  provider: SummaryProvider | null
  userId: string
  note: { id: string; title: string; content: string }
  locale: string
  length?: SummaryLength
}

export type GenerateSummaryOutcome =
  | { ok: true; summary: AiNoteSummary; neurons: number }
  | { ok: false; code: SummaryErrorCode }

export type SummaryErrorCode =
  | 'ai_unavailable'
  | 'quota_exhausted'
  | 'ai_failed'
  | 'truncated'
  | 'empty_result'

/**
 * 生成并直接落库。第一版只有「首次生成」，草稿、历史版本、自动更新留待后续。
 * 模型不可用时不影响笔记本身：调用方把错误码变成 503 即可。
 */
export async function generateSummary(input: GenerateSummaryInput): Promise<GenerateSummaryOutcome> {
  const { db, provider, userId, note } = input
  if (!provider) return { ok: false, code: 'ai_unavailable' }

  const usage = await readUsage(db, userId)
  if (remainingNeurons(usage.neurons) === 0) return { ok: false, code: 'quota_exhausted' }

  const sourceHash = await summarySourceHash(note.title, note.content)
  let result
  try {
    result = await provider.generate({
      title: note.title,
      content: note.content,
      language: input.locale,
      length: input.length ?? 'medium',
    })
  } catch (error) {
    // 失败也记一笔，避免模型异常时无限重试时把额度烧光。
    await recordUsage(db, {
      userId,
      model: SUMMARY_MODEL,
      neurons: 0,
      inputTokens: 0,
      outputTokens: 0,
      success: false,
      date: utcDateKey(),
    }).catch(() => undefined)
    if (error instanceof SummaryProviderError) return { ok: false, code: 'ai_failed' }
    throw error
  }

  // 截断内容不能当摘要：半句话比没有更糟。
  if (result.truncated) {
    await recordUsage(db, {
      userId,
      model: result.model,
      neurons: result.neurons,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      success: false,
    }).catch(() => undefined)
    return { ok: false, code: 'truncated' }
  }

  const text = result.text.trim().slice(0, LIMITS.aiSummaryMaxChars)
  if (!text) return { ok: false, code: 'empty_result' }

  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = excluded.summary_origin,
         summary_language = excluded.summary_language,
         source_hash = excluded.source_hash,
         summary_status = excluded.summary_status,
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at
       WHERE note_summaries.user_id = excluded.user_id`,
    )
    .bind(
      note.id,
      userId,
      text,
      'ai',
      input.locale,
      sourceHash,
      'current',
      result.model,
      PROMPT_VERSION,
      now,
    )
    .run()

  await recordUsage(db, {
    userId,
    model: result.model,
    neurons: result.neurons,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    success: true,
  }).catch(() => undefined)

  return {
    ok: true,
    neurons: result.neurons,
    summary: {
      noteId: note.id,
      text,
      origin: 'ai',
      status: 'current',
      language: input.locale,
      model: result.model,
      generatedAt: now,
      updatedAt: now,
    },
  }
}

/** 用户手动编辑摘要：来源固定为 user，且以当前正文为基准避免立刻过期。 */
export async function saveUserSummary(input: {
  db: D1Database
  userId: string
  note: { id: string; title: string; content: string }
  text: string
  locale: string
}): Promise<void> {
  const existing = await loadSummary(input.db, input.userId, input.note.id)
  const sourceHash = await summarySourceHash(input.note.title, input.note.content)
  const now = Date.now()
  await input.db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at)
       VALUES (?1, ?2, ?3, 'user', ?4, ?5, 'current', ?6, ?7, ?8, ?9)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = 'user',
         summary_status = 'current',
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at
       WHERE note_summaries.user_id = excluded.user_id`,
    )
    .bind(
      input.note.id,
      input.userId,
      input.text,
      existing?.summary_language ?? input.locale,
      sourceHash,
      existing?.model ?? null,
      existing ? null : PROMPT_VERSION,
      existing?.generated_at ?? now,
      now,
    )
    .run()
}
