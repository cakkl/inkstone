import { useEffect, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'
import type { AiSummaryVersion } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { fullTime, relativeTime } from '../../lib/time'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'

/** 摘要历史：与笔记版本历史同款弹窗，左侧列表、右侧查看全文。 */
export function SummaryHistoryDialog({ noteId, open, onClose, onRestore }: {
  noteId: string
  open: boolean
  onClose: () => void
  onRestore: (version: AiSummaryVersion) => Promise<void> | void
}) {
  const [versions, setVersions] = useState<AiSummaryVersion[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setVersions(null)
    setFailed(false)
    api.notes
      .summaryVersions(noteId)
      .then((result) => {
        if (cancelled) return
        setVersions(result.versions)
        setSelectedId(result.versions[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [noteId, open, reload])

  const selected = versions?.find((version) => version.id === selectedId) ?? null

  const restore = async () => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await onRestore(selected)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('summary.history')}
      width={880}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" icon={<RotateCcw size={13} />} disabled={!selected || busy} loading={busy} onClick={() => void restore()}>
            {t('summary.history_restore')}
          </Button>
        </>
      }
    >
      {failed ? (
        <Empty
          art="notes"
          compact
          title={t('summary.history_empty')}
          action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}
        />
      ) : versions === null ? (
        <LoadingBlock />
      ) : versions.length === 0 ? (
        <Empty art="notes" compact title={t('summary.history_empty')} />
      ) : (
        <div className="flex h-[min(68dvh,560px)] min-h-0 flex-col gap-3 md:h-[400px] md:flex-row">
          <ul className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2 md:block md:w-[210px] md:space-y-px md:overflow-y-auto md:border-r md:border-b-0 md:pr-2 md:pb-0">
            {versions.map((version) => (
              <li key={version.id} className="w-[188px] shrink-0 md:w-auto">
                <button
                  type="button"
                  aria-pressed={selectedId === version.id}
                  onClick={() => setSelectedId(version.id)}
                  className={cn(
                    'w-full rounded-[var(--r-md)] px-2 py-2 text-left transition-colors',
                    selectedId === version.id ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
                    <History size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                    {relativeTime(version.createdAt)}
                  </div>
                  <div className="mt-0.5 pl-4 text-[10.5px] text-[var(--text-quaternary)]">
                    {version.origin === 'user' ? t('summary.origin_user') : t('summary.origin_ai')}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]">
            {selected ? (
              <>
                <div className="sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-[10.5px] text-[var(--text-quaternary)]">
                  {fullTime(selected.createdAt)}
                </div>
                <p className="whitespace-pre-wrap p-3 text-[13px] leading-relaxed text-[var(--text-primary)]">
                  {selected.text}
                </p>
              </>
            ) : (
              <LoadingBlock />
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
