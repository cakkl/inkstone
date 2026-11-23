import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { computeSummaryPolicy, DEFAULT_NOTE_SUMMARY_SETTINGS } from '@shared/summary-policy'
import type { AiSummaryNoteMode } from '@shared/types'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Drawer, confirm } from '../../components/overlay'
import { Segmented } from '../../components/form'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'

type Tri = 'inherit' | 'on' | 'off'
type Page = 'root' | 'summary'

const toTri = (value: boolean | null | undefined): Tri => (value == null ? 'inherit' : value ? 'on' : 'off')
const fromTri = (value: Tri): boolean | null => (value === 'inherit' ? null : value === 'on')
const aiToTri = (mode: AiSummaryNoteMode | undefined): Tri =>
  mode === 'enabled' ? 'on' : mode === 'disabled' ? 'off' : 'inherit'

/** 笔记设置；摘要相关集中到子页面。入口须独立于摘要区，否则关闭摘要后再无入口。 */
export function NoteSettingsDrawer({ open, onClose, noteId, onChanged }: {
  open: boolean
  onClose: () => void
  noteId: string
  onChanged: () => void
}) {
  const toast = useUi((s) => s.toast)
  /** 实例关闭 AI 摘要后，这两段开关没有意义，直接不渲染。 */
  const instanceAiEnabled = useSession((s) => s.site?.aiSummary.enabled ?? true)
  /** 实例不允许自动摘要时，单篇的「自动生成」也不会生效。 */
  const instanceAuto = useSession((s) => s.site?.aiSummary.allowAutoGenerate ?? true)
  const siteAi = useSession((s) => s.site?.aiSummary)
  const userAi = useSession((s) => s.settings.aiSummary)
  /** 摘要与单篇设置随笔记同步，打开抽屉就能直接用，不必等接口。 */
  const note = useNotes((s) => s.notes[noteId])
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<Page>('root')

  useEffect(() => {
    if (!open) setPage('root')
  }, [open])

  const settings = note?.summarySettings ?? DEFAULT_NOTE_SUMMARY_SETTINGS
  const policy = computeSummaryPolicy({
    instance: siteAi ?? { enabled: true, allowAutoGenerate: false },
    user: { enabled: userAi.enabled, autoGenerate: userAi.autoGenerate },
    note: settings,
    hasSummary: Boolean(note?.summary),
  })

  const apply = async (patch: Parameters<typeof api.notes.setSummarySettings>[1]) => {
    if (busy) return
    setBusy(true)
    try {
      const next = await api.notes.setSummarySettings(noteId, patch)
      // 本地立即生效，后续 sync 会以服务端值为准。
      useNotes.getState().setNoteSummarySettings(noteId, next.settings)
      useNotes.getState().setNoteSummary(noteId, next.summary)
      onChanged()
      toast({ title: t('summary.saved') })
    } catch {
      toast({ title: t('summary.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const ask = (title: string, description: string) =>
    confirm({ title, description, confirmLabel: t('workspace.disable_confirm'), tone: 'danger' })

  const changeSummary = async (next: Tri) => {
    if (next === 'off' && !(await ask(t('workspace.note_disable_summary_title'), t('workspace.note_disable_summary_warning')))) return
    await apply({ summaryEnabled: fromTri(next) })
  }

  const changeAi = async (next: Tri) => {
    if (next === 'off' && !(await ask(t('workspace.note_disable_ai_title'), t('workspace.note_disable_ai_warning')))) return
    await apply({ aiMode: next === 'inherit' ? 'inherit' : next === 'on' ? 'enabled' : 'disabled' })
  }

  const summaryState = toTri(policy.summaryEnabled)
  const statusText = summaryState === 'off'
    ? t('workspace.note_off')
    : policy.visible
      ? t('workspace.note_on')
      : t('workspace.note_summary_auto')

  return (
    <Drawer open={open} onClose={onClose} side="right" width={340} title={t('workspace.note_settings')}>
      {page === 'root' ? (
        <div className="py-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
            onClick={() => setPage('summary')}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-[var(--text-primary)]">{t('workspace.note_summary_section')}</span>
            <span className="mt-0.5 block text-[11.5px] text-[var(--text-tertiary)]">{statusText}</span>
          </span>
          <ChevronRight size={14} className="shrink-0 text-[var(--text-quaternary)]" />
        </button>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-3">
          <button
            type="button"
            className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setPage('root')}
          >
            <ChevronLeft size={14} />
            {t('workspace.note_settings')}
          </button>

              <div className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                  {t('workspace.note_summary_section')}
                </h3>
                <Segmented
                  value={summaryState}
                  disabled={busy}
                  onChange={(value) => void changeSummary(value)}
                  options={[
                    { value: 'inherit', label: t('workspace.note_summary_auto') },
                    { value: 'on', label: t('workspace.note_on') },
                    { value: 'off', label: t('workspace.note_off') },
                  ]}
                />
                <p className="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
                  {t('workspace.note_summary_hint')}
                </p>
              </div>

              {instanceAiEnabled && (
                <>
                  <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
                    <h3 className="px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                      {t('workspace.note_ai_section')}
                    </h3>
                    <Segmented
                      value={aiToTri(settings.aiMode)}
                      disabled={busy}
                      onChange={(value) => void changeAi(value)}
                      options={[
                        { value: 'inherit', label: t('workspace.note_summary_auto') },
                        { value: 'on', label: t('workspace.note_on') },
                        { value: 'off', label: t('workspace.note_off') },
                      ]}
                    />
                  </div>

                  {instanceAuto && (
                    <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
                      <h3 className="px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                        {t('workspace.note_auto_section')}
                      </h3>
                      <Segmented
                        value={toTri(settings.autoGenerate)}
                        disabled={busy}
                        onChange={(value) => void apply({ autoGenerate: fromTri(value) })}
                        options={[
                          { value: 'inherit', label: t('workspace.note_summary_auto') },
                          { value: 'on', label: t('workspace.note_on') },
                          { value: 'off', label: t('workspace.note_off') },
                        ]}
                      />
                    </div>
                  )}
                </>
              )}
        </div>
      )}
    </Drawer>
  )
}
