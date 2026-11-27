import type { AiSummaryNoteMode } from './types'

/**
 * 摘要策略的唯一判定函数，前后端共用。
 *
 * 后端用它生成接口响应，前端用同一套规则从本地同步下来的设置推导，
 * 所以规则只此一处：改这里不会出现「按钮可点但请求被拒」的错位。
 */

export interface SummaryInstanceInput {
  enabled: boolean
  allowAutoGenerate: boolean
}

export interface SummaryUserInput {
  enabled: boolean
  autoGenerate: boolean
}

export interface SummaryNoteInput {
  /** `null` 表示未设置，按内容与自动生成推导。 */
  summaryEnabled: boolean | null
  /** 这篇是否允许 AI 摘要。 */
  aiMode: AiSummaryNoteMode
  /** 单篇自动生成；`null` 表示跟随用户设置。 */
  autoGenerate: boolean | null
}

export interface SummaryPolicy extends SummaryNoteInput {
  instanceEnabled: boolean
  userEnabled: boolean
  /** 是否显示摘要区。 */
  visible: boolean
  /** 是否允许 AI 生成（手写不受影响）。 */
  canGenerate: boolean
  /** 是否允许自动生成（夜间排队）。 */
  autoEligible: boolean
}

export const DEFAULT_NOTE_SUMMARY_SETTINGS: SummaryNoteInput = {
  summaryEnabled: null,
  aiMode: 'inherit',
  autoGenerate: null,
}

export function normalizeNoteSummarySettings(value: unknown): SummaryNoteInput {
  if (!value || typeof value !== 'object') return DEFAULT_NOTE_SUMMARY_SETTINGS
  const raw = value as Partial<SummaryNoteInput>
  const summaryEnabled = typeof raw.summaryEnabled === 'boolean' ? raw.summaryEnabled : null
  const autoGenerate = typeof raw.autoGenerate === 'boolean' ? raw.autoGenerate : null
  const aiMode: AiSummaryNoteMode =
    raw.aiMode === 'enabled' || raw.aiMode === 'disabled' ? raw.aiMode : 'inherit'
  return { summaryEnabled, aiMode, autoGenerate }
}

export function computeSummaryPolicy(input: {
  instance: SummaryInstanceInput
  user: SummaryUserInput
  note: SummaryNoteInput
  hasSummary: boolean
}): SummaryPolicy {
  const { instance, user, note } = input
  const canGenerate = instance.enabled && user.enabled && note.aiMode !== 'disabled'
  const autoOn = note.autoGenerate ?? user.autoGenerate
  // 单篇关闭摘要即完全退出自动生成，否则编辑正文仍会排队。
  const autoEligible =
    canGenerate && note.summaryEnabled !== false && instance.allowAutoGenerate && autoOn
  const visible = note.summaryEnabled ?? (input.hasSummary || autoEligible)
  return {
    ...note,
    instanceEnabled: instance.enabled,
    userEnabled: user.enabled,
    visible,
    canGenerate,
    autoEligible,
  }
}
