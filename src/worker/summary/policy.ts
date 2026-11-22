import { mergeSettings } from '@shared/constants'
import type { AiSummaryNoteMode } from '@shared/types'
import { getAiSummarySettings } from '../lib/instance-settings'

export interface NoteSummaryFlags {
  /** `null` 表示「未设置」，按内容与自动生成推导。 */
  summaryEnabled: boolean | null
  /** 这篇是否允许 AI 摘要（`disabled` 表示不允许）。 */
  aiMode: AiSummaryNoteMode
  /** 单篇自动生成：`null` 表示跟随用户设置。 */
  autoGenerate: boolean | null
}

export interface SummaryPolicy extends NoteSummaryFlags {
  instanceEnabled: boolean
  userEnabled: boolean
  /** 是否显示摘要区。 */
  visible: boolean
  /** 是否允许 AI 生成（手写不受影响）。 */
  canGenerate: boolean
  /** 是否允许自动生成（夜间排队）。 */
  autoEligible: boolean
}

export function parseNoteMode(value: unknown): AiSummaryNoteMode {
  return value === 'enabled' || value === 'disabled' ? value : 'inherit'
}

function parseFlag(value: unknown): boolean | null {
  if (value === 1 || value === true) return true
  if (value === 0 || value === false) return false
  return null
}

export async function loadNoteFlags(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<NoteSummaryFlags> {
  const row = await db
    .prepare(
      `SELECT summary_enabled, auto_mode, auto_generate
         FROM note_summary_settings WHERE note_id = ?1 AND user_id = ?2`,
    )
    .bind(noteId, userId)
    .first<{ summary_enabled: number | null; auto_mode: string; auto_generate: number | null }>()
  return {
    summaryEnabled: parseFlag(row?.summary_enabled),
    aiMode: parseNoteMode(row?.auto_mode),
    autoGenerate: parseFlag(row?.auto_generate),
  }
}

export async function setNoteFlags(
  db: D1Database,
  userId: string,
  noteId: string,
  patch: Partial<NoteSummaryFlags>,
): Promise<void> {
  const current = await loadNoteFlags(db, userId, noteId)
  const next: NoteSummaryFlags = {
    summaryEnabled: patch.summaryEnabled === undefined ? current.summaryEnabled : patch.summaryEnabled,
    aiMode: patch.aiMode === undefined ? current.aiMode : patch.aiMode,
    autoGenerate: patch.autoGenerate === undefined ? current.autoGenerate : patch.autoGenerate,
  }
  const encode = (value: boolean | null) => (value === null ? null : value ? 1 : 0)
  await db
    .prepare(
      `INSERT INTO note_summary_settings (note_id, user_id, auto_mode, auto_generate, summary_enabled, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(note_id) DO UPDATE SET
         auto_mode = excluded.auto_mode,
         auto_generate = excluded.auto_generate,
         summary_enabled = excluded.summary_enabled,
         updated_at = excluded.updated_at
       WHERE note_summary_settings.user_id = excluded.user_id`,
    )
    .bind(
      noteId,
      userId,
      next.aiMode,
      encode(next.autoGenerate),
      encode(next.summaryEnabled),
      Date.now(),
    )
    .run()
}

/** 唯一判定入口（路由/队列/前端共用）：有单篇设置用设置，否则有内容或会产出时显示。 */
export async function resolveSummaryPolicy(input: {
  db: D1Database
  userId: string
  noteId: string
  settingsRaw: string
  hasSummary: boolean
}): Promise<SummaryPolicy> {
  const instance = await getAiSummarySettings(input.db)
  let user = mergeSettings({}).aiSummary
  try {
    user = mergeSettings(JSON.parse(input.settingsRaw)).aiSummary
  } catch {
    // Malformed settings fall back to defaults instead of failing the request.
  }
  const flags = await loadNoteFlags(input.db, input.userId, input.noteId)

  const instanceEnabled = instance.enabled
  const userEnabled = user.enabled
  const canGenerate = instanceEnabled && userEnabled && flags.aiMode !== 'disabled'
  const autoOn = flags.autoGenerate ?? user.autoGenerate
  const autoEligible = canGenerate && instance.allowAutoGenerate && autoOn
  const visible = flags.summaryEnabled ?? (input.hasSummary || autoEligible)

  return { ...flags, instanceEnabled, userEnabled, visible, canGenerate, autoEligible }
}
