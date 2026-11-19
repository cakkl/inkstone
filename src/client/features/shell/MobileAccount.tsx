import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, LogOut, Waypoints } from 'lucide-react';
import { ACCENTS } from '@shared/constants';
import { Avatar } from '../../components/primitives';
import { t } from '../../lib/i18n';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { SECTIONS, SettingsPage } from '../settings/SettingsPanel';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { warmSettingsSection, type SettingsSection } from '../settings/sections';
import { requestBack, useBackLayer } from '../../lib/back-stack';
import { EDGE_SWIPE_EXIT_MS, useEdgeSwipeBack } from '../../lib/edge-swipe';

const ACCOUNT_DETAIL_EXIT_FALLBACK_MS = 3000;

export function MobileAccount() {
    const user = useSession((s) => s.user);
    const logout = useSession((s) => s.logout);
    const [section, setSection] = useState<SettingsSection | null>(null);
    const [closing, setClosing] = useState<SettingsSection | null>(null);
    const [loggingOut, setLoggingOut] = useState(false);
    const detailRef = useRef<HTMLElement>(null);
    const listRef = useRef<HTMLElement>(null);
    const listSettleTimer = useRef(0);
    useEffect(() => () => window.clearTimeout(listSettleTimer.current), []);
    const detail = section ?? closing;
    useLayoutEffect(() => {
        const element = detailRef.current;
        if (!element || !section) return;
        void element.offsetHeight;
        element.setAttribute('data-open', '');
        return () => {
            element.removeAttribute('data-open');
        };
    }, [section]);
    const hideSection = () => {
        if (!section) return;
        setClosing(section);
        setSection(null);
    };
    useEffect(() => {
        if (!closing) return;
        const element = detailRef.current;
        const finish = () => setClosing(null);
        if (!element) {
            finish();
            return;
        }
        const onEnd = (event: TransitionEvent) => {
            if (event.target === element && event.propertyName === 'transform')
                finish();
        };
        element.addEventListener('transitionend', onEnd);
        const timer = window.setTimeout(finish, ACCOUNT_DETAIL_EXIT_FALLBACK_MS);
        return () => {
            element.removeEventListener('transitionend', onEnd);
            window.clearTimeout(timer);
        };
    }, [closing]);
    useBackLayer(section !== null, 'mobile-account-section', hideSection);
    const settleList = () => {
        const element = listRef.current;
        if (!element) return;
        window.clearTimeout(listSettleTimer.current);
        listSettleTimer.current = window.setTimeout(() => {
            element.style.transition = '';
            element.style.transform = '';
        }, 60);
    };
    const swipe = useEdgeSwipeBack(section !== null, requestBack, {
        onDrag: (distance, width) => {
            const element = listRef.current;
            if (!element) return;
            const progress = Math.min(1, distance / Math.max(1, width));
            window.clearTimeout(listSettleTimer.current);
            element.style.transition = 'none';
            element.style.transform = `translateX(${-30 + 30 * progress}%)`;
        },
        onDragEnd: (commit) => {
            const element = listRef.current;
            if (!element) return;
            window.clearTimeout(listSettleTimer.current);
            element.style.transition = `transform ${EDGE_SWIPE_EXIT_MS}ms var(--ease-out)`;
            element.style.transform = commit ? 'translateX(0%)' : 'translateX(-30%)';
        },
        onDragChange: (dragging) => {
            if (!dragging) settleList();
        },
    });
    const openSection = (next: SettingsSection) => {
        warmSettingsSection(next);
        setSection(next);
    };
    const closeDetail = () => {
        if (!requestBack())
            hideSection();
    };
    const accountList = (<section ref={listRef} data-pushed={section ? true : undefined} className="mobile-account-list flex h-full flex-col overflow-y-auto bg-[var(--bg-surface)] p-4">
        <h1 className="py-2 text-xl font-semibold">{t('mobile.account')}</h1>
        {user && <div className="flex items-center gap-4 py-6">
            <Avatar src={user.avatarUrl} name={user.name || user.username} size={56}/>
            <div className="min-w-0"><p className="truncate text-lg font-semibold">{user.name || user.username}</p><p className="truncate text-sm text-[var(--text-tertiary)]">@{user.username}</p></div>
        </div>}
        <div className="shrink-0 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)]">
            {SECTIONS.map((item) => <button key={item.id} type="button" onClick={() => openSection(item.id)} className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-sm active:bg-[var(--bg-active)]"><span aria-hidden="true" className="text-[var(--accent)]">{item.icon}</span><span className="flex-1">{item.label()}</span><ChevronRight size={16} aria-hidden="true" className="text-[var(--text-tertiary)]"/></button>)}
            <button type="button" onClick={() => useUi.getState().openPanel('graph')} className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-sm active:bg-[var(--bg-active)]"><Waypoints size={16} aria-hidden="true"/><span className="flex-1">{t('common.graph')}</span><ChevronRight size={16} aria-hidden="true"/></button>
        </div>
        <div className="min-h-6 flex-1"/>
        <button type="button" disabled={loggingOut} aria-busy={loggingOut} onClick={async () => { setLoggingOut(true); try { await logout(); } finally { setLoggingOut(false); } }} className="mt-4 flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-sm text-[var(--danger)] active:bg-[var(--bg-active)] disabled:opacity-50"><LogOut size={16} aria-hidden="true"/>{t('sidebar.log_out')}</button>
    </section>);
    return (<div className="relative h-full min-h-0">
      {accountList}
      {detail && (<section ref={detailRef} {...swipe} className="mobile-settings-detail absolute inset-0 flex min-h-0 flex-col bg-[var(--bg-surface)]">
        <header className="relative flex min-h-14 shrink-0 items-center border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
            <button type="button" aria-label={t('mobile.back_to_account')} onClick={closeDetail} className="flex size-11 items-center justify-center rounded-lg active:bg-[var(--bg-active)]"><ArrowLeft size={20}/></button>
            <h1 className="pointer-events-none absolute inset-x-14 text-center text-[15px] font-semibold">{SECTIONS.find((item) => item.id === detail)?.label()}</h1>
        </header>
        <div className="mobile-settings-content min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[calc(24px+env(safe-area-inset-bottom))]">{detail === 'appearance' ? <AppearanceSettings accents={ACCENTS}/> : <SettingsPage section={detail}/>}</div>
      </section>)}
    </div>);
}
