import type { NoteSummarySettings, StoredNoteSummary } from '@shared/types'
import { DEFAULT_NOTE_SUMMARY_SETTINGS } from '@shared/summary-policy'

export interface NoteSummaryBundle {
  summary: StoredNoteSummary | null
  settings: NoteSummarySettings
}

/** D1 单个查询最多 99 个绑定参数（含 userId），按 80 分块留余量。 */
const SUMMARY_QUERY_CHUNK = 80

interface SummaryRow {
  note_id: string
  summary_text: string
  summary_origin: string
  summary_status: string
  updated_at: number
}

interface SettingRow {
  note_id: string
  summary_enabled: number | null
  auto_mode: string
  auto_generate: number | null
}

/**
 * 批量取摘要与单篇设置，供同步与列表接口把摘要挂到笔记上。
 *
 * 摘要不写进 `notes` 表：`notes.updated_at` 同时驱动列表排序、同步冲突判定与
 * 自动摘要的静默期，AI 写摘要若碰它会让队列永远等不到「安静 4 小时」。
 */
export async function loadNoteSummaryBundles(
  db: D1Database,
  userId: string,
  noteIds: readonly string[],
): Promise<Map<string, NoteSummaryBundle>> {
  const out = new Map<string, NoteSummaryBundle>()
  if (noteIds.length === 0) return out
  for (const id of noteIds) {
    out.set(id, { summary: null, settings: { ...DEFAULT_NOTE_SUMMARY_SETTINGS } })
  }

  // 全量同步一次最多 500 篇，超出一个查询的参数上限，因此分块。
  const chunks: string[][] = []
  for (let index = 0; index < noteIds.length; index += SUMMARY_QUERY_CHUNK) {
    chunks.push(noteIds.slice(index, index + SUMMARY_QUERY_CHUNK))
  }

  const [summaryPages, settingPages] = await Promise.all([
    Promise.all(chunks.map((chunk) => fetchSummaries(db, userId, chunk))),
    Promise.all(chunks.map((chunk) => fetchSettings(db, userId, chunk))),
  ])

  for (const row of summaryPages.flat()) {
    const bundle = out.get(row.note_id)
    if (!bundle) continue
    bundle.summary = {
      text: row.summary_text,
      origin: row.summary_origin === 'user' ? 'user' : 'ai',
      status: row.summary_status === 'outdated' ? 'outdated' : 'current',
      updatedAt: row.updated_at,
    }
  }

  const flag = (value: number | null) => (value === 1 ? true : value === 0 ? false : null)
  for (const row of settingPages.flat()) {
    const bundle = out.get(row.note_id)
    if (!bundle) continue
    bundle.settings = {
      summaryEnabled: flag(row.summary_enabled),
      aiMode:
        row.auto_mode === 'enabled' || row.auto_mode === 'disabled' ? row.auto_mode : 'inherit',
      autoGenerate: flag(row.auto_generate),
    }
  }

  return out
}

async function fetchSummaries(db: D1Database, userId: string, noteIds: string[]): Promise<SummaryRow[]> {
  const marks = noteIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT note_id, summary_text, summary_origin, summary_status, updated_at
         FROM note_summaries
        WHERE user_id = ?1 AND note_id IN (${marks})`,
    )
    .bind(userId, ...noteIds)
    .all<SummaryRow>()
  return results
}

async function fetchSettings(db: D1Database, userId: string, noteIds: string[]): Promise<SettingRow[]> {
  const marks = noteIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT note_id, summary_enabled, auto_mode, auto_generate
         FROM note_summary_settings
        WHERE user_id = ?1 AND note_id IN (${marks})`,
    )
    .bind(userId, ...noteIds)
    .all<SettingRow>()
  return results
}

/** 把摘要挂到笔记摘要对象上；没有摘要时把 `summary` 置为 `null`，便于客户端区分「没摘要」与「没同步」。 */
export function attachNoteSummaries<T extends { id: string; summary?: StoredNoteSummary | null; summarySettings?: NoteSummarySettings }>(
  notes: T[],
  bundles: Map<string, NoteSummaryBundle>,
): T[] {
  return notes.map((note) => {
    const bundle = bundles.get(note.id)
    if (!bundle) return { ...note, summary: null, summarySettings: { ...DEFAULT_NOTE_SUMMARY_SETTINGS } }
    return { ...note, summary: bundle.summary, summarySettings: bundle.settings }
  })
}

/**
 * 摘要写入后通知同步：客户端据此重取这条笔记（响应会带新 summary）。
 * 不记成 `note` 变更，避免客户端把摘要更新误当成正文被远程修改。
 */
export async function notifySummaryChanged(
  db: D1Database,
  userId: string,
  noteId: string,
  op: 'upsert' | 'delete' = 'upsert',
): Promise<void> {
  await db
    .prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'summary', ?2, ?3, ?4)`)
    .bind(userId, noteId, op, Date.now())
    .run()
}
