import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { AiNoteSummaryResponse } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useBreakpoint } from '../../lib/hooks'
import { Button, IconButton } from '../../components/primitives'
import { Textarea } from '../../components/form'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'

/** 摘要面板：inline 时作为正文顶部一块，否则为独立面板；编辑模式下可改但需保存。 */
export function SummaryPanel({ noteId, updatedAt, disabled, editable = false, inline = false, collapseSignal, expandSignal, refreshToken, className }: {
  noteId: string
  updatedAt?: number
  disabled?: boolean
  /** 笔记处于编辑模式时才允许修改摘要。 */
  editable?: boolean
  /** Render as a block inside the note body instead of a separated panel. */
  inline?: boolean
  /** Increases when the note scrolls down; the panel collapses. */
  collapseSignal?: number
  /** Increases on layout or note switch; the panel expands again. */
  expandSignal?: number
  /** 任意变更后自增，强制重新读取。 */
  refreshToken?: number
  className?: string
}) {
  const toast = useUi((state) => state.toast)
  const aiSettings = useSession((state) => state.settings.aiSummary)
  const isMobile = useBreakpoint() === 'mobile'
  const [state, setState] = useState<AiNoteSummaryResponse | null>(null)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<'generate' | 'save' | 'accept' | null>(null)
  /** null means untouched: show the saved text; leaving edit mode discards it. */
  const [draft, setDraft] = useState<string | null>(null)
  /** null means untouched AI draft; a string holds the user's tweaks. */
  const [draftEdit, setDraftEdit] = useState<string | null>(null)
  const loadedNoteRef = useRef<string | null>(null)

  useEffect(() => {
    if (!editable) {
      // Read mode is view-only: drop both the typed text and any draft tweaks.
      setDraft(null)
      setDraftEdit(null)
    }
  }, [editable])

  const pendingText = state?.draft?.text ?? null
  useEffect(() => {
    setDraftEdit(null)
  }, [pendingText])

  useEffect(() => {
    // Collapse only on downward scrolling; expanding is left to the reader.
    if (collapseSignal) setOpen(false)
  }, [collapseSignal])

  useEffect(() => {
    if (expandSignal) setOpen(true)
  }, [expandSignal])

  useEffect(() => {
    const controller = new AbortController()
    const newNote = loadedNoteRef.current !== noteId
    if (newNote) {
      loadedNoteRef.current = noteId
      setState(null)
      setDraft(null)
      setDraftEdit(null)
      setBusy(null)
    }
    const timer = window.setTimeout(() => {
      api.notes
        .summary(noteId, controller.signal)
        .then((next) => {
          setState(next)
        })
        .catch(() => undefined)
    }, newNote ? 0 : 800)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [noteId, updatedAt, refreshToken, aiSettings.enabled, aiSettings.autoGenerate])

  const reportFailure = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.isOffline) {
      toast({ title: t('summary.offline'), tone: 'warning' })
      return
    }
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
      setDraft(null)
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

  const applyDraft = useCallback(async () => {
    const pending = state?.draft
    if (!pending || busy) return
    const edited = draftEdit?.trim() ?? ''
    setBusy('accept')
    try {
      if (edited && edited !== pending.text.trim()) {
        // Tweaked AI text becomes a user summary, so the stale draft is dropped too.
        await api.notes.saveSummary(noteId, edited)
        setState(await api.notes.discardSummaryDraft(noteId))
      } else {
        setState(await api.notes.acceptSummaryDraft(noteId))
      }
      setDraftEdit(null)
      setDraft(null)
      toast({ title: t('summary.saved') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, draftEdit, noteId, reportFailure, state?.draft, toast])

  const discardDraft = useCallback(async () => {
    if (busy) return
    setBusy('accept')
    try {
      setState(await api.notes.discardSummaryDraft(noteId))
      setDraftEdit(null)
      toast({ title: t('summary.deleted') })
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(null)
    }
  }, [busy, noteId, reportFailure, toast])

  if (!state?.visible) return null

  const summary = state.summary
  const pending = state.draft ?? null
  const generating = busy === 'generate'
  // open is the single source of truth so the chevron still collapses in edit mode.
  const expanded = open
  const value = draft ?? summary?.text ?? ''
  const dirty = draft !== null && draft.trim() !== (summary?.text ?? '').trim()
  const generateLabel = summary ? t('summary.regenerate') : t('summary.generate')
  const generateDisabled = disabled || busy !== null || state.remainingNeurons === 0
  const draftDirty = draftEdit !== null && pending !== null && draftEdit.trim() !== pending.text.trim()
  const emptyHint = !state.canGenerate
    ? t('summary.empty_manual_only')
    : state.autoEligible
      ? t('summary.empty_auto')
      : t('summary.empty_can_generate')

  return (
    <section
      className={cn(
        'shrink-0',
        inline ? 'bg-transparent' : 'border-b border-[var(--border-subtle)] bg-[var(--bg-editor)]',
        className,
      )}
      data-summary-panel
    >
      <div className={cn('flex items-center gap-2', inline ? 'py-1' : 'px-3 py-1.5')}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onClick={() => setOpen(!open)}
          aria-expanded={expanded}
        >
          <Sparkles size={13} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="shrink-0">{t('summary.title')}</span>
          <ChevronDown
            size={13}
            className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform', expanded && 'rotate-180')}
          />
          {generating && <span className="summary-shimmer min-w-0 truncate text-[11.5px]">{t('summary.generating')}</span>}
          {!generating && pending && (
            <span className="min-w-0 truncate text-[11.5px] text-[var(--accent)]">
              {editable ? t('summary.draft_pending') : t('summary.draft_pending_readonly')}
            </span>
          )}
          {!generating && !pending && (
            <span className={cn(
              'min-w-0 truncate text-[11.5px] font-normal',
              summary?.status === 'outdated' ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]',
            )}>
              {summary
                ? summary.status === 'outdated'
                  ? t('summary.outdated')
                  : summary.origin === 'user' ? t('summary.origin_user') : t('summary.origin_ai')
                : emptyHint}
            </span>
          )}
        </button>
        {editable && state.canGenerate && (isMobile ? (
          <IconButton
            label={generateLabel}
            size="sm"
            disabled={generateDisabled}
            onClick={() => void generate()}
          >
            <Sparkles size={13} />
          </IconButton>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="whitespace-nowrap"
            icon={<Sparkles size={12} />}
            loading={generating}
            disabled={generateDisabled}
            onClick={() => void generate()}
          >
            {generateLabel}
          </Button>
        ))}
      </div>

      {expanded && (
        <div className={inline ? 'pb-2' : 'px-3 pb-2.5'}>
          {editable ? (
            <div className="space-y-2">
              <Textarea
                value={value}
                rows={4}
                placeholder={summary ? undefined : emptyHint}
                disabled={disabled || busy !== null}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={t('summary.title')}
              />
              <div className="flex flex-wrap items-center gap-2">
                {dirty && (
                  <>
                    <Button
                      size="sm"
                      loading={busy === 'save'}
                      disabled={disabled || !value.trim() || busy !== null}
                      onClick={() => void save()}
                    >
                      {t('summary.save')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDraft(null)}>
                      {t('summary.cancel')}
                    </Button>
                  </>
                )}
                {!dirty && !summary && (
                  <span className="text-[11.5px] text-[var(--text-quaternary)]">{emptyHint}</span>
                )}
              </div>
            </div>
          ) : (
            <p
              className={cn(
                'whitespace-pre-wrap px-1 py-0.5 text-[13px] leading-relaxed',
                summary ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
              )}
            >
              {summary ? summary.text : emptyHint}
            </p>
          )}

          {generating && (
            <div className="mt-2 space-y-1">
              {summary && <div className="h-px bg-[var(--border-subtle)]" />}
              <p className="summary-shimmer text-[13px] leading-relaxed">{t('summary.generating')}</p>
            </div>
          )}

          {pending && !generating && editable && (
            <div className="mt-2 space-y-1 border-t border-[var(--border-subtle)] pt-2" data-summary-draft>
              <div className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                {t('summary.draft_question')}
              </div>
              {draftEdit === null ? (
                <button
                  type="button"
                  className="block w-full whitespace-pre-wrap rounded-[var(--r-sm)] px-1 py-0.5 text-left text-[13px] leading-relaxed text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  onClick={() => setDraftEdit(pending.text)}
                >
                  {pending.text}
                </button>
              ) : (
                <Textarea
                  value={draftEdit}
                  rows={3}
                  disabled={disabled || busy !== null}
                  onChange={(event) => setDraftEdit(event.target.value)}
                  aria-label={t('summary.draft_title')}
                />
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  loading={busy === 'accept'}
                  disabled={busy !== null || (draftEdit !== null && !draftEdit.trim())}
                  onClick={() => void applyDraft()}
                >
                  {t('summary.draft_accept')}
                </Button>
                {draftDirty && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDraftEdit(pending.text)}>
                    {t('summary.draft_reset')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void discardDraft()}>
                  {t('summary.draft_discard')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
