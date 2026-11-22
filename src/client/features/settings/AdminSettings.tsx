import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { SettingRow, Switch } from '../../components/form'
import { useUi } from '../../store/ui'

interface InstanceSettings {
  enabled: boolean
  allowAutoGenerate: boolean
}

/** 实例级开关只影响能否发起新请求，不会删除任何已保存的摘要。 */
export function AdminSettings() {
  const toast = useUi((s) => s.toast)
  const [instance, setInstance] = useState<InstanceSettings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.settings
      .aiSummary()
      .then(setInstance)
      .catch(() => undefined)
  }, [])

  const save = async (patch: Partial<InstanceSettings>) => {
    if (busy) return
    setBusy(true)
    try {
      setInstance(await api.settings.updateAiSummary(patch))
      toast({ title: t('summary.saved') })
    } catch {
      toast({ title: t('summary.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (!instance) return null

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
        {t('settings.ai_summary_admin_hint')}
      </p>
      <section className="space-y-1">
        <SettingRow
          title={t('settings.ai_summary_instance_enabled')}
          description={t('settings.ai_summary_instance_enabled_hint')}
        >
          <Switch
            checked={instance.enabled}
            onChange={(enabled) => void save({ enabled })}
            label={t('settings.ai_summary_instance_enabled')}
          />
        </SettingRow>
        <SettingRow
          title={t('settings.ai_summary_instance_auto')}
          description={t('settings.ai_summary_instance_auto_hint')}
        >
          <Switch
            checked={instance.allowAutoGenerate}
            onChange={(allowAutoGenerate) => void save({ allowAutoGenerate })}
            label={t('settings.ai_summary_instance_auto')}
          />
        </SettingRow>
      </section>
    </div>
  )
}
