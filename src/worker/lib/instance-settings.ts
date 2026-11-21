import { getMeta, setMeta } from '../db/metadata'


const KEY_REGISTRATION_OPEN = 'setting:allow_registration'
const KEY_AI_SUMMARY = 'setting:ai_summary'

export interface AiSummaryInstanceSettings {
  /** 实例是否允许调用 AI 摘要。关闭后已有摘要仍可读。 */
  enabled: boolean
  /** 是否允许自动生成/更新；关闭后手动仍可用。 */
  allowAutoGenerate: boolean
}

export const DEFAULT_AI_SUMMARY_SETTINGS: AiSummaryInstanceSettings = {
  enabled: true,
  allowAutoGenerate: false,
}

export async function getAiSummarySettings(db: D1Database): Promise<AiSummaryInstanceSettings> {
  const raw = await getMeta(db, KEY_AI_SUMMARY)
  if (!raw) return DEFAULT_AI_SUMMARY_SETTINGS
  try {
    const parsed = JSON.parse(raw) as Partial<AiSummaryInstanceSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_AI_SUMMARY_SETTINGS.enabled,
      allowAutoGenerate:
        typeof parsed.allowAutoGenerate === 'boolean'
          ? parsed.allowAutoGenerate
          : DEFAULT_AI_SUMMARY_SETTINGS.allowAutoGenerate,
    }
  } catch {
    return DEFAULT_AI_SUMMARY_SETTINGS
  }
}

export async function setAiSummarySettings(
  db: D1Database,
  patch: Partial<AiSummaryInstanceSettings>,
): Promise<AiSummaryInstanceSettings> {
  const current = await getAiSummarySettings(db)
  const next: AiSummaryInstanceSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    allowAutoGenerate:
      typeof patch.allowAutoGenerate === 'boolean' ? patch.allowAutoGenerate : current.allowAutoGenerate,
  }
  await setMeta(db, KEY_AI_SUMMARY, JSON.stringify(next))
  return next
}

export async function getAllowRegistration(db: D1Database): Promise<boolean> {
  return (await getMeta(db, KEY_REGISTRATION_OPEN)) === '1'
}

export async function setAllowRegistration(db: D1Database, enabled: boolean): Promise<void> {
  await setMeta(db, KEY_REGISTRATION_OPEN, enabled ? '1' : '0')
}
