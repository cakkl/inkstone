import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import type { AiNoteSummaryResponse } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Textarea } from '../../components/form'
import { useUi } from '../../store/ui'

type LoadState = 'loading' | 'ready' | 'failed'

export function SummaryPanel({ noteId, updatedAt, disabled, className }: {
  noteId: string
  /** 笔记更新时间：变化后重新读取摘要状态，让「已过期」及时出现。 */
  updatedAt?: number
  disabled?: boolean
  className?: string
}) {
  const toast = useUi((state) => state.toast)
  const [state, setState] = useState<AiNoteSummaryResponse | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'save' | 'delete' | 'accept' | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const loadedNoteRef = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const newNote = loadedNoteRef.current !== noteId
    if (newNote) {
      loadedNoteRef.current = noteId
      setState(null)
      setLoadState('loading')
      setDraft(null)
      setBusy(null)
    }
    // 正文变化后的刷新稍作延迟，避免逐字符请求。
    const timer = window.setTimeout(() => {
      api.notes
        .summary(noteId, controller.signal)
        .then((next) => {
          setState(next)
          setLoadState('ready')
          if (newNote) setOpen(Boolean(next.summary))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setLoadState('failed')
          if (error instanceof ApiError && error.isOffline) return
        })
    }, newNote ? 0 : 800)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [noteId, updatedAt])

  const reportFailure = useCallback((error: unknown) => {
    const code = error instanceof ApiError ? error.code : ''
    const message = code === 'ai_quota_exhausted'
      ? t('summary.quota')
      : code === 'ai_unavailable'
        ? t('summary.unavailable')
        : t('summary.failed')
    toast({ title: message, tone: 'danger' })
  }, [toast])

  const generate = useCallback(async () => {
    if (busy) return
    setBusy('generate')
    try {
      const next = await api.notes.generateSummary(noteId)
      setState(next)
      setOpen(true)
      toast({ title: t('summary.generated') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, noteId, reportFailure, toast])

  const save = useCallback(async () => {
    if (draft === null || busy) return
    const text = draft.trim()
    if (!text) return
    setBusy('save')
    try {
      setState(await api.notes.saveSummary(noteId, text))
      setDraft(null)
      toast({ title: t('summary.saved') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, draft, noteId, reportFailure, toast])

  const remove = useCallback(async () => {
    if (busy) return
    setBusy('delete')
    try {
      await api.notes.deleteSummary(noteId)
      setState((prev) => (prev ? { ...prev, summary: null } : prev))
      setDraft(null)
      toast({ title: t('summary.deleted') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, noteId, reportFailure, toast])

  const acceptDraftText = useCallback(async () => {
    if (busy) return
    setBusy('accept')
    try {
      setState(await api.notes.acceptSummaryDraft(noteId))
      toast({ title: t('summary.saved') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, noteId, reportFailure, toast])

  const discardDraftText = useCallback(async () => {
    if (busy) return
    setBusy('accept')
    try {
      setState(await api.notes.discardSummaryDraft(noteId))
      toast({ title: t('summary.deleted') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, noteId, reportFailure, toast])

  const summary = state?.summary ?? null
  const pendingDraft = state?.draft ?? null
  const tooShort = state !== null && state.characterCount < state.minimumCharacters
  const quotaExhausted = state !== null && state.remainingNeurons === 0

  const statusText = loadState === 'failed'
    ? t('summary.failed')
    : summary
      ? summary.status === 'outdated'
        ? t('summary.outdated')
        : summary.origin === 'user' ? t('summary.origin_user') : t('summary.origin_ai')
      : tooShort ? t('summary.too_short', { value0: String(state?.minimumCharacters ?? 100) }) : t('summary.empty')

  return (
    <section
      className={cn('shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-editor)]', className)}
      data-summary-panel
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-[var(--text-secondary)]"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <Sparkles size={13} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="shrink-0">{t('summary.title')}</span>
          <ChevronDown
            size={13}
            className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform', open && 'rotate-180')}
          />
          {loadState === 'loading' && <Spinner size={11} />}
          {loadState !== 'loading' && (
            <span className={cn(
              'min-w-0 truncate text-[11.5px] font-normal',
              pendingDraft
                ? 'text-[var(--accent)]'
                : summary?.status === 'outdated' ? 'text-[var(--warning,#b45309)]' : 'text-[var(--text-quaternary)]',
            )}>
              {pendingDraft ? t('summary.draft_pending') : statusText}
            </span>
          )}
        </button>
        {summary && (
          <>
            <IconButton
              label={t('summary.edit')}
              size="sm"
              disabled={disabled || busy !== null}
              onClick={() => { setDraft(summary.text); setOpen(true) }}
            >
              <Pencil size={13} />
            </IconButton>
            <IconButton
              label={t('summary.delete')}
              size="sm"
              disabled={disabled || busy !== null}
              onClick={() => void remove()}
            >
              <Trash2 size={13} />
            </IconButton>
          </>
        )}
      </div>

      {open && (
        <div className="px-3 pb-2.5">
          {draft !== null ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                rows={4}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={t('summary.edit')}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" loading={busy === 'save'} disabled={!draft.trim()} onClick={() => void save()}>
                  {t('summary.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  {t('summary.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className={cn(
                'whitespace-pre-wrap text-[13px] leading-relaxed',
                summary ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
              )}>
                {summary ? summary.text : statusText}
              </p>
              {pendingDraft && (
                <div
                  className="mt-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-2"
                  data-summary-draft
                >
                  <div className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                    {t('summary.draft_title')}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-primary)]">
                    {pendingDraft.text}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      loading={busy === 'accept'}
                      disabled={disabled || busy !== null}
                      onClick={() => void acceptDraftText()}
                    >
                      {t('summary.draft_accept')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || busy !== null}
                      onClick={() => void discardDraftText()}
                    >
                      {t('summary.draft_discard')}
                    </Button>
                  </div>
                </div>
              )}
              {summary && (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === 'generate'}
                    disabled={disabled || quotaExhausted}
                    icon={<RefreshCw size={12} />}
                    onClick={() => void generate()}
                  >
                    {t('summary.regenerate')}
                  </Button>
                </div>
              )}
              {!summary && (
                <Button
                  size="sm"
                  className="mt-2"
                  loading={busy === 'generate'}
                  disabled={disabled || quotaExhausted}
                  icon={<Sparkles size={12} />}
                  onClick={() => void generate()}
                >
                  {t('summary.generate')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
