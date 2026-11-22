import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { SettingRow, Switch } from '../../components/form'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { SettingsLoading } from './SettingsLoading'

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
      const next = await api.settings.updateAiSummary(patch)
      setInstance(next)
      // 站点信息里也存了实例开关，不同步的话关闭后当前会话仍然看得到相关设置项。
      const site = useSession.getState().site
      if (site) useSession.setState({ site: { ...site, aiSummary: next } })
      toast({ title: t('summary.saved') })
    } catch {
      toast({ title: t('summary.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  // 数据未到时给骨架：直接 return null 会在 lazy 加载完、接口未回之间留一大块空白。
  if (!instance) return <SettingsLoading rows={2} />

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
        {/* The child switch is meaningless while the instance switch is off. */}
        {instance.enabled && (
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
        )}
      </section>
    </div>
  )
}
