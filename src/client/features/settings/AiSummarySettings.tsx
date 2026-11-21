import { t } from '../../lib/i18n'
import { SettingRow, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useSession } from '../../store/session'

/** 用户级开关；Owner 额外看到实例级开关。 */
export function AiSummarySettings() {
  const settings = useSession((s) => s.settings)
  const updateSettings = useSession((s) => s.updateSettings)

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
      </section>
    </div>
  )
}
