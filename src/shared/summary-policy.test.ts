import { describe, expect, it } from 'vitest'
import { computeSummaryPolicy, normalizeNoteSummarySettings, DEFAULT_NOTE_SUMMARY_SETTINGS } from './summary-policy'

const INSTANCE_ON = { enabled: true, allowAutoGenerate: true }
const INSTANCE_NO_AUTO = { enabled: true, allowAutoGenerate: false }
const INSTANCE_OFF = { enabled: false, allowAutoGenerate: true }
const USER_ON = { enabled: true, autoGenerate: true }
const USER_OFF = { enabled: false, autoGenerate: false }

describe('computeSummaryPolicy', () => {
  it('三层都开启且允许自动时，才具备自动生成资格', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: USER_ON,
      note: DEFAULT_NOTE_SUMMARY_SETTINGS,
      hasSummary: false,
    })
    expect(policy.canGenerate).toBe(true)
    expect(policy.autoEligible).toBe(true)
    // 没有摘要但会自动产出：面板要显示，好让用户知道今晚会生成。
    expect(policy.visible).toBe(true)
  })

  it('实例关闭 AI 后不能生成，也不自动生成', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_OFF,
      user: USER_ON,
      note: DEFAULT_NOTE_SUMMARY_SETTINGS,
      hasSummary: true,
    })
    expect(policy.canGenerate).toBe(false)
    expect(policy.autoEligible).toBe(false)
    // 已有摘要仍要能看到。
    expect(policy.visible).toBe(true)
  })

  it('用户关闭 AI 后不能生成，但实例允许也不自动生成', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: USER_OFF,
      note: DEFAULT_NOTE_SUMMARY_SETTINGS,
      hasSummary: false,
    })
    expect(policy.canGenerate).toBe(false)
    expect(policy.autoEligible).toBe(false)
  })

  it('单篇禁用 AI 只影响生成，不影响显示', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: USER_ON,
      note: { summaryEnabled: null, aiMode: 'disabled', autoGenerate: null },
      hasSummary: true,
    })
    expect(policy.canGenerate).toBe(false)
    expect(policy.visible).toBe(true)
  })

  it('单篇关闭摘要后不显示', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: USER_ON,
      note: { summaryEnabled: false, aiMode: 'inherit', autoGenerate: null },
      hasSummary: true,
    })
    expect(policy.visible).toBe(false)
  })

  it('单篇开启摘要但没有任何内容与自动生成时也显示', () => {
    const policy = computeSummaryPolicy({
      instance: INSTANCE_NO_AUTO,
      user: { enabled: true, autoGenerate: false },
      note: { summaryEnabled: true, aiMode: 'inherit', autoGenerate: null },
      hasSummary: false,
    })
    expect(policy.visible).toBe(true)
    expect(policy.autoEligible).toBe(false)
  })

  it('单篇自动生成设置覆盖用户设置', () => {
    const off = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: USER_ON,
      note: { summaryEnabled: null, aiMode: 'inherit', autoGenerate: false },
      hasSummary: false,
    })
    expect(off.autoEligible).toBe(false)

    const on = computeSummaryPolicy({
      instance: INSTANCE_ON,
      user: { enabled: true, autoGenerate: false },
      note: { summaryEnabled: null, aiMode: 'inherit', autoGenerate: true },
      hasSummary: false,
    })
    expect(on.autoEligible).toBe(true)
  })
})

describe('normalizeNoteSummarySettings', () => {
  it('脏数据回落到默认值', () => {
    expect(normalizeNoteSummarySettings(null)).toEqual(DEFAULT_NOTE_SUMMARY_SETTINGS)
    expect(normalizeNoteSummarySettings({ aiMode: 'bogus', summaryEnabled: 'yes' })).toEqual(
      DEFAULT_NOTE_SUMMARY_SETTINGS,
    )
  })

  it('保留合法值', () => {
    expect(
      normalizeNoteSummarySettings({ summaryEnabled: false, aiMode: 'disabled', autoGenerate: true }),
    ).toEqual({ summaryEnabled: false, aiMode: 'disabled', autoGenerate: true })
  })
})
