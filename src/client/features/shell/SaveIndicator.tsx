import { CloudOff, FileText } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../components/overlay';
import { useRelativeTime } from '../../lib/hooks';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";


export function SaveIndicator({ onlyWhenPending = false, showLabel = false }: { onlyWhenPending?: boolean; showLabel?: boolean } = {}) {
    const status = useNotes((s) => s.saveStatus);
    const lastSavedAt = useNotes((s) => s.lastSavedAt);
    const online = useNotes((s) => s.online);
    const pending = useNotes((s) => s.pendingCount);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const draft = useNotes((s) => (activeNoteId ? s.drafts.has(activeNoteId) : false));
    const offline = !online || status === 'offline';
    const saving = status === 'saving';
    const dirty = status === 'dirty';
    const synced = status === 'synced' || status === 'idle';
    const savedAgo = useRelativeTime(lastSavedAt, !offline && !saving && !dirty);
    // 展开式列表页不需要常驻一个绿勾；只在有可报告的状态时占位。
    if (onlyWhenPending && !offline && !saving && !dirty && !pending && !draft)
        return null;
    const shortLabel = draft
        ? t("notes.draft")
        : offline
            ? pending
                ? t("shell.offline_value0_changes_pending", { value0: pending })
                : t("shell.offline")
            : saving
                ? t("shell.saving")
                : dirty
                    ? t("shell.unsaved_changes")
                    : t("shell.synced");
    const text = showLabel ? <span aria-hidden="true" className="truncate text-[11.5px]">{shortLabel}</span> : null;
    if (draft) {
        return (<Tooltip label={t("notes.draft_hint")} side="bottom">
        <span role="img" aria-label={t("notes.draft")} className="flex h-6 items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-[11px] text-[var(--text-tertiary)]">
          <FileText size={13}/>
          {showLabel ? text : <span aria-hidden="true" className="hidden md:inline">{t("notes.draft")}</span>}
        </span>
      </Tooltip>);
    }
    const label = offline
        ? pending
            ? t("shell.offline_value0_changes_pending", { value0: pending })
            : t("shell.offline_changes_are_saved_locally")
        : saving
            ? t("shell.saving")
            : dirty
                ? t("shell.unsaved_changes")
                : lastSavedAt
                    ? t("shell.synced_value0", { value0: savedAgo })
                    : t("shell.synced");
    if (offline) {
        return (<Tooltip label={label} side="bottom">
        <span role="img" aria-label={label} className="flex h-6 items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-[11px] text-[var(--warning)]">
          <CloudOff size={13}/>
          {showLabel ? text : <span aria-hidden="true" className="hidden md:inline">{t("shell.offline")}</span>}
        </span>
      </Tooltip>);
    }
    return (<Tooltip label={label} side="bottom">
      <span role="img" aria-label={label} className={cn('flex size-7 items-center justify-center', showLabel && 'w-auto gap-1.5 px-1')}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          { }
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.6" className={cn('transition-[opacity,color] duration-[var(--dur-base)]', saving
            ? 'text-[var(--text-quaternary)] opacity-30'
            : dirty
                ? 'text-[var(--text-quaternary)] opacity-40'
                : 'text-[var(--success)] opacity-30')}/>
          { }
          <path d="M13.4 8A5.4 5.4 0 0 0 8 2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className={cn('origin-center text-[var(--accent)] transition-opacity duration-150', saving ? 'animate-[ink-spin_.72s_linear_infinite] opacity-100' : 'opacity-0')}/>
          { }
          <circle cx="8" cy="8" r="2.4" fill="currentColor" className={cn('origin-center text-[var(--text-tertiary)] transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-spring)]', dirty ? 'scale-100 opacity-100' : 'scale-0 opacity-0')}/>
          { }
          <path d="M5.4 8.2 7.1 9.9l3.6-3.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className={cn('text-[var(--success)] transition-[stroke-dashoffset,opacity] duration-[var(--dur-slow)] ease-[var(--ease-out)]', synced ? 'opacity-100' : 'opacity-0')} style={{
            strokeDasharray: 1,
            strokeDashoffset: synced ? 0 : 1,
        }}/>
        </svg>
        {text}
      </span>
    </Tooltip>);
}
