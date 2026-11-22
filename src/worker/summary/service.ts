import { LIMITS } from '@shared/constants'
import type { AiNoteSummary } from '@shared/types'
import { sha256Hex } from '../lib/encoding'
import { pushVersion, saveDraft } from './drafts'
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
  summary_evolved: number
  refine_count: number
  last_fresh_at: number | null
}

/** 连续补充超过该次数、或距上次全新生成超过该天数时，下一次自动改为全新生成。 */
export const REFINE_DRIFT_MAX = 10
const REFINE_DRIFT_MAX_AGE = 90 * 24 * 60 * 60 * 1000

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

/**
 * 显式模式优先；否则「含用户口径」时继续补充，但连续补充过多或久未重整则退回全新生成。
 */
export function resolveMode(
  requested: SummaryMode | undefined,
  existing: SummaryRow | null,
  now: number,
): SummaryMode {
  if (!existing) return 'fresh'
  if (requested) return requested
  if (existing.summary_evolved !== 1) return 'fresh'
  if (existing.refine_count >= REFINE_DRIFT_MAX) return 'fresh'
  if (existing.last_fresh_at && now - existing.last_fresh_at > REFINE_DRIFT_MAX_AGE) return 'fresh'
  return 'refine'
}

/** 正文指纹：判断摘要在生成后是否已过期。 */
export function summarySourceHash(title: string, content: string): Promise<string> {
  return sha256Hex(`${title}\u0000${content}`)
}

export async function loadSummary(db: D1Database, userId: string, noteId: string): Promise<SummaryRow | null> {
  return db
    .prepare(
      `SELECT note_id, summary_text, summary_origin, summary_status, summary_language,
              source_hash, model, generated_at, updated_at,
              summary_evolved, refine_count, last_fresh_at
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
  /** 用户手改过的摘要只能进草稿，不能直接覆盖。 */
  asDraft?: boolean
  /** 显式指定模式；省略时按谱系与防漂移规则推导。 */
  mode?: SummaryMode
  /** 补充式里用户写的要求。 */
  instruction?: string
}

export type SummaryMode = 'fresh' | 'refine'

export type GenerateSummaryOutcome =
  | { ok: true; target: 'summary'; mode: SummaryMode; summary: AiNoteSummary; neurons: number }
  | { ok: true; target: 'draft'; mode: SummaryMode; draftText: string; neurons: number }
  | { ok: false; code: SummaryErrorCode }

export type SummaryErrorCode =
  | 'ai_unavailable'
  | 'quota_exhausted'
  | 'ai_failed'
  | 'truncated'
  | 'empty_result'

/** `asDraft` 或已有用户手改内容时只写草稿，避免覆盖人写的东西。 */
export async function generateSummary(input: GenerateSummaryInput): Promise<GenerateSummaryOutcome> {
  const { db, provider, userId, note } = input
  if (!provider) return { ok: false, code: 'ai_unavailable' }

  const usage = await readUsage(db, userId)
  if (remainingNeurons(usage.neurons) === 0) return { ok: false, code: 'quota_exhausted' }

  const existing = await loadSummary(db, userId, note.id)
  const mode = resolveMode(input.mode, existing, Date.now())
  const sourceHash = await summarySourceHash(note.title, note.content)
  let result
  try {
    result = await provider.generate({
      title: note.title,
      content: note.content,
      language: input.locale,
      length: input.length ?? 'medium',
      previousSummary: mode === 'refine' ? existing?.summary_text : undefined,
      instruction: mode === 'refine' ? input.instruction : undefined,
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
  const draftOnly = input.asDraft === true || existing?.summary_origin === 'user'

  await recordUsage(db, {
    userId,
    model: result.model,
    neurons: result.neurons,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    success: true,
  }).catch(() => undefined)

  if (draftOnly) {
    await saveDraft(db, {
      userId,
      noteId: note.id,
      text,
      operation: mode,
      sourceHash,
      baseUpdatedAt: existing?.updated_at ?? null,
      model: result.model,
      promptVersion: PROMPT_VERSION,
    })
    return { ok: true, target: 'draft', mode, draftText: text, neurons: result.neurons }
  }

  if (existing) await pushVersion(db, userId, existing, 'generate')
  await db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at,
          summary_evolved, refine_count, last_fresh_at)
       VALUES (?1, ?2, ?3, 'ai', ?4, ?5, 'current', ?6, ?7, ?8, ?8, ?9, ?10, ?11)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = 'ai',
         summary_language = excluded.summary_language,
         source_hash = excluded.source_hash,
         summary_status = 'current',
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at,
         summary_evolved = excluded.summary_evolved,
         refine_count = excluded.refine_count,
         last_fresh_at = excluded.last_fresh_at
       WHERE note_summaries.user_id = excluded.user_id`,
    )
    .bind(
      note.id,
      userId,
      text,
      input.locale,
      sourceHash,
      result.model,
      PROMPT_VERSION,
      now,
      mode === 'refine' ? 1 : 0,
      mode === 'refine' ? (existing?.refine_count ?? 0) + 1 : 0,
      mode === 'refine' ? (existing?.last_fresh_at ?? null) : now,
    )
    .run()

  return {
    ok: true,
    target: 'summary',
    mode,
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

/** 手改后来源固定为 user，且以当前正文为基准，避免立刻显示过期。 */
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
  if (existing) await pushVersion(input.db, input.userId, existing, 'manual')
  await input.db
    .prepare(
      `INSERT INTO note_summaries
         (note_id, user_id, summary_text, summary_origin, summary_language, source_hash,
          summary_status, model, prompt_version, generated_at, updated_at,
          summary_evolved, refine_count, last_fresh_at)
       VALUES (?1, ?2, ?3, 'user', ?4, ?5, 'current', ?6, ?7, ?8, ?9, 1, 0, ?10)
       ON CONFLICT(note_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         summary_origin = 'user',
         summary_status = 'current',
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at,
         summary_evolved = 1,
         refine_count = 0
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
      existing?.last_fresh_at ?? null,
    )
    .run()
}
