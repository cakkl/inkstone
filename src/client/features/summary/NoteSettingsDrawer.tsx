import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { AiNoteSummaryResponse, AiSummaryNoteMode } from '@shared/types'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Drawer, confirm } from '../../components/overlay'
import { Segmented } from '../../components/form'
import { useUi } from '../../store/ui'

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
  const [state, setState] = useState<AiNoteSummaryResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<Page>('root')

  useEffect(() => {
    if (!open) {
      setPage('root')
      return
    }
    let cancelled = false
    api.notes
      .summary(noteId)
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, noteId])

  const apply = async (patch: Parameters<typeof api.notes.setSummarySettings>[1]) => {
    if (busy) return
    setBusy(true)
    try {
      const next = await api.notes.setSummarySettings(noteId, patch)
      setState(next)
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

  const summaryState = toTri(state?.settings.summaryEnabled)
  const statusText = summaryState === 'off'
    ? t('workspace.note_off')
    : state?.visible ? t('workspace.note_on') : t('workspace.note_summary_auto')

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

          <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
            <h3 className="px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
              {t('workspace.note_ai_section')}
            </h3>
            <Segmented
              value={aiToTri(state?.settings.aiMode)}
              disabled={busy}
              onChange={(value) => void changeAi(value)}
              options={[
                { value: 'inherit', label: t('workspace.note_summary_auto') },
                { value: 'on', label: t('workspace.note_on') },
                { value: 'off', label: t('workspace.note_off') },
              ]}
            />
          </div>

          <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
            <h3 className="px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
              {t('workspace.note_auto_section')}
            </h3>
            <Segmented
              value={toTri(state?.settings.autoGenerate)}
              disabled={busy}
              onChange={(value) => void apply({ autoGenerate: fromTri(value) })}
              options={[
                { value: 'inherit', label: t('workspace.note_summary_auto') },
                { value: 'on', label: t('workspace.note_on') },
                { value: 'off', label: t('workspace.note_off') },
              ]}
            />
          </div>
        </div>
      )}
    </Drawer>
  )
}
