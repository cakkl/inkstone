import { useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { SettingRow, Switch } from '../../components/form'
import { Button } from '../../components/primitives'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'

/** 用户级开关；关闭自动生成前确认，并可一键为没有摘要的笔记补投任务。 */
export function AiSummarySettings() {
  const settings = useSession((s) => s.settings)
  const updateSettings = useSession((s) => s.updateSettings)
  const toast = useUi((s) => s.toast)
  const [queueDepth, setQueueDepth] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.settings
      .aiSummary()
      .then((info) => {
        if (!cancelled) setQueueDepth(info.queueDepth)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const backfill = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.settings.backfillAiSummary()
      setQueueDepth((current) => (current ?? 0) + result.queued)
      toast({ title: t('settings.ai_summary_backfill_queued', { value0: result.queued }) })
    } catch {
      toast({ title: t('summary.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const autoOn = settings.aiSummary.enabled && settings.aiSummary.autoGenerate

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <SettingRow
          title={t('settings.ai_summary_enabled')}
          description={t('settings.ai_summary_enabled_hint')}
        >
          <Switch
            checked={settings.aiSummary.enabled}
            onChange={(enabled) => {
              if (enabled) {
                updateSettings({ aiSummary: { enabled } })
                return
              }
              void confirm({
                title: t('settings.ai_summary_disable_title'),
                description: t('settings.ai_summary_disable_warning'),
                confirmLabel: t('workspace.disable_confirm'),
                tone: 'danger',
              }).then((ok) => {
                if (ok) updateSettings({ aiSummary: { enabled: false } })
              })
            }}
            label={t('settings.ai_summary_enabled')}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.ai_summary_auto')}
          description={t('settings.ai_summary_auto_hint')}
        >
          <Switch
            checked={settings.aiSummary.autoGenerate}
            onChange={(autoGenerate) => updateSettings({ aiSummary: { autoGenerate } })}
            label={t('settings.ai_summary_auto')}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.ai_summary_backfill')}
          description={t('settings.ai_summary_backfill_hint')}
        >
          <div className="flex items-center gap-2">
            {queueDepth !== null && queueDepth > 0 && (
              <span className="text-[11.5px] text-[var(--text-quaternary)]">
                {t('settings.ai_summary_queue_depth', { value0: queueDepth })}
              </span>
            )}
            <Button size="sm" variant="secondary" loading={busy} disabled={!autoOn || busy} onClick={() => void backfill()}>
              {t('settings.ai_summary_backfill_action')}
            </Button>
          </div>
        </SettingRow>
      </section>
    </div>
  )
}
