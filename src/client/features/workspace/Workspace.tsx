import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { ArrowLeft, Columns2, Download, Eye, FileCode, FileDown, FileText, FolderClosed, Hash, History, Link as LinkIcon, ListTree, MoreHorizontal, PanelRightClose, Pencil, Plus, Share2, Star, X, } from 'lucide-react';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { readingMinutes } from '@shared/markdown-utils';
import { LIMITS } from '@shared/constants';
import type { EditorLayout } from '@shared/types';
import { fullTime } from '../../lib/time';
import { useBreakpoint, useRelativeTime } from '../../lib/hooks';
import { prettyCombo } from '../../lib/hotkeys';
import { Button, IconButton } from '../../components/primitives';
import { Drawer, Menu, Tooltip, type MenuItem } from '../../components/overlay';
import { Segmented } from '../../components/form';
import { EditorSkeleton, Empty } from '../../components/feedback';
import { DeferredCodeEditor } from '../../editor/CodeEditor';
import { insertFiles } from '../../editor/paste';
import { optimizeImageFile } from '../../lib/image';
import { exportNote as runNoteExport } from '../../lib/export-note';
import { Preview } from '../preview/Preview';
import { Outline } from '../preview/Outline';
import { SplitResizer } from '../shell/Resizer';
import { EditorToolbar } from './EditorToolbar';
import { BacklinksPanel } from './BacklinksPanel';
import { SaveIndicator } from '../shell/SaveIndicator';
import type { Heading } from '../../lib/markdown/renderer';
import { useUi, type WorkspacePane } from '../../store/ui';
import { useSession } from '../../store/session';
import { createContextualNote, useActiveNote, useNotes } from '../../store/notes';
import { folderPathLabel, openFolderView } from '../../lib/folders';
import { useSyncScroll } from './sync-scroll';
import { runServerOnly as runServerOnlyAction } from './server-only';
import { captureReadingPosition, readReadingPosition, readingPositionKey, restoreReadingPosition, writeReadingPosition } from './reading-position';
import { t, useLocale } from "../../lib/i18n";
import { preferredScrollBehavior } from '../../lib/motion';
const SPLIT_HANDLE_WIDTH = 1;
const PREVIEW_BORDER_WIDTH = 1;
const OUTLINE_WIDTH = 168;
export function Workspace({ onMobileBack, pane = 'active', grouped = false, }: {
    onMobileBack?: () => void;
    pane?: WorkspacePane | 'active';
    grouped?: boolean;
} = {}) {
    const { note, content, loaded } = useActiveNote(pane);
    const loadError = useNotes((s) => note ? s.noteLoadErrors[note.id] : undefined);
    const settings = useSession((s) => s.settings);
    const userId = useSession((s) => s.user?.id);
    const updateSettings = useSession((s) => s.updateSettings);
    const editContent = useNotes((s) => s.editContent);
    const editTitle = useNotes((s) => s.editTitle);
    const patchNote = useNotes((s) => s.patchNote);
    const tags = useNotes((s) => s.tags);
    const folders = useNotes((s) => s.folders);
    const notes = useNotes((s) => s.notes);
    const toast = useUi((s) => s.toast);
    const locale = useLocale();
    const openPanel = useUi((s) => s.openPanel);
    const outlineOpen = useUi((s) => s.outlineOpen);
    const backlinksOpen = useUi((s) => s.backlinksOpen);
    const toggleOutline = useUi((s) => s.toggleOutline);
    const toggleBacklinks = useUi((s) => s.toggleBacklinks);
    const splitRatio = useUi((s) => s.splitRatio);
    const setLayout = useUi((s) => s.setLayout);
    const activeWorkspacePane = useUi((s) => s.activeWorkspacePane);
    const workspacePaneLayouts = useUi((s) => s.workspacePaneLayouts);
    const setWorkspacePaneLayout = useUi((s) => s.setWorkspacePaneLayout);
    const activateWorkspacePane = useUi((s) => s.activateWorkspacePane);
    const closeSecondaryNote = useUi((s) => s.closeSecondaryNote);
    const breakpoint = useBreakpoint();
    const containerRef = useRef<HTMLDivElement>(null);
    const previewScrollerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const moreButtonRef = useRef<HTMLButtonElement>(null);
    const exportMenuRef = useRef<HTMLButtonElement>(null);
    const [view, setView] = useState<EditorView | null>(null);
    // 编辑器与预览的像素高度不同，坐标不能互用，各存一份。
    const editorReadingKey = userId && note ? readingPositionKey(userId, note.id, 'editor') : null;
    const previewReadingKey = userId && note ? readingPositionKey(userId, note.id, 'preview') : null;
    const pendingReadingRef = useRef<{ key: string; position: ReturnType<typeof captureReadingPosition> } | null>(null);
    const readingTimerRef = useRef<number | undefined>(undefined);
    const editorScrollCleanupRef = useRef<(() => void) | null>(null);
    const flushReadingPosition = useCallback(() => {
        window.clearTimeout(readingTimerRef.current);
        const pending = pendingReadingRef.current;
        pendingReadingRef.current = null;
        if (pending) writeReadingPosition(pending.key, pending.position);
    }, []);
    const saveReadingPosition = useCallback((scroller: HTMLElement, key: string | null) => {
        if (!key || !scroller.clientHeight) return;
        pendingReadingRef.current = { key, position: captureReadingPosition(scroller) };
        window.clearTimeout(readingTimerRef.current);
        readingTimerRef.current = window.setTimeout(flushReadingPosition, 180);
    }, [flushReadingPosition]);
    const restoreReading = useCallback((scroller: HTMLElement, key: string | null) => {
        if (!key) return;
        const pending = pendingReadingRef.current;
        const position = pending?.key === key ? pending.position : readReadingPosition(key);
        if (position) restoreReadingPosition(scroller, position);
    }, []);
    useEffect(() => {
        window.addEventListener('pagehide', flushReadingPosition);
        return () => {
            window.removeEventListener('pagehide', flushReadingPosition);
            flushReadingPosition();
        };
    }, [editorReadingKey, flushReadingPosition]);
    const onEditorReady = useCallback((next: EditorView | null) => {
        editorScrollCleanupRef.current?.();
        editorScrollCleanupRef.current = null;
        setView(next);
        if (!next) return;
        const scroller = next.scrollDOM;
        const position = editorReadingKey
            ? pendingReadingRef.current?.key === editorReadingKey
                ? pendingReadingRef.current.position
                : readReadingPosition(editorReadingKey)
            : null;
        let frame = window.requestAnimationFrame(() => {
            frame = window.requestAnimationFrame(() => {
                if (position) restoreReadingPosition(scroller, position);
            });
        });
        const onScroll = () => saveReadingPosition(scroller, editorReadingKey);
        scroller.addEventListener('scroll', onScroll, { passive: true });
        editorScrollCleanupRef.current = () => {
            window.cancelAnimationFrame(frame);
            scroller.removeEventListener('scroll', onScroll);
        };
    }, [editorReadingKey, saveReadingPosition]);
    const [headings, setHeadings] = useState<Heading[]>([]);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const [exportMenuOpen, setExportMenuOpen] = useState(false);
    const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
    const [containerWidth, setContainerWidth] = useState(0);
    const isMobile = breakpoint === 'mobile';
    const isDraftNote = useNotes((s) => (note ? s.drafts.has(note.id) : false));
    const online = useNotes((s) => s.online);
    const serverOnlyReason = isDraftNote
        ? t("notes.draft_unavailable")
        : !online ? t("common.offline_unavailable") : null;
    const serverOnlyDisabled = serverOnlyReason !== null;
    const paneActive = !grouped || pane === 'active' || activeWorkspacePane === pane;
    const noteView = useUi((s) => s.noteView);
    const setNoteView = useUi((s) => s.setNoteView);
    const readingMobile = isMobile && noteView === 'read';
    const layout = isMobile ? (readingMobile ? 'preview' : 'live') : grouped && pane !== 'active'
            ? workspacePaneLayouts[pane]
            : settings.preview.layout;
    const showEditor = layout !== 'preview';
    const livePreviewEnabled = settings.editor.livePreview;
    // 隐藏期间沿用最后一次可见的渲染模式：查看模式布局是 preview，若据此关掉即时渲染，
    // compartment 会被重配置、高度图重建，切回时位置就会跳。
    const lastShownLayoutRef = useRef(layout);
    if (showEditor) lastShownLayoutRef.current = layout;
    const livePreviewActive = livePreviewEnabled && (showEditor ? layout === 'live' : lastShownLayoutRef.current === 'live');
    const showPreview = layout !== 'live';
    const showSplit = layout === 'split';
    const outlineVisible = !isMobile && outlineOpen && paneActive && headings.length > 0;
    const defaultOutlineWidth = outlineVisible ? OUTLINE_WIDTH : 0;
    const defaultContentWidth = Math.max(0, containerWidth - SPLIT_HANDLE_WIDTH - PREVIEW_BORDER_WIDTH - defaultOutlineWidth);
    const defaultEditorWidth = defaultContentWidth / 2;
    const defaultPreviewWidth = PREVIEW_BORDER_WIDTH + defaultOutlineWidth + defaultEditorWidth;
    const effectiveSplitRatio = splitRatio ?? (containerWidth > 0 ? defaultEditorWidth / containerWidth : 0.5);
    const tagColors = useMemo(() => new Map(tags.map((tag) => [tag.name, tag.color])), [tags]);
    const editorWidth = splitRatio === null
        ? containerWidth > 0
            ? `${defaultEditorWidth}px`
            : `calc((100% - ${SPLIT_HANDLE_WIDTH + PREVIEW_BORDER_WIDTH + defaultOutlineWidth}px) / 2)`
        : `${splitRatio * 100}%`;
    const previewWidth = splitRatio === null
        ? containerWidth > 0
            ? `${defaultPreviewWidth}px`
            : `calc((100% + ${PREVIEW_BORDER_WIDTH + defaultOutlineWidth - SPLIT_HANDLE_WIDTH}px) / 2)`
        : `${(1 - splitRatio) * 100}%`;
    const updatedTime = useRelativeTime(note?.updatedAt ?? 0, Boolean(note));
    // 只在换笔记时清空：清空会让大纲列消失、编辑区宽度变化，进而带偏滚动位置。
    useLayoutEffect(() => {
        setHeadings([]);
        setMobileOutlineOpen(false);
    }, [note?.id]);
    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container)
            return;
        const measure = () => {
            const next = container.getBoundingClientRect().width;
            setContainerWidth((current) => Math.abs(current - next) < 0.5 ? current : next);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [loaded, note?.id]);
    const setEditorLayout = (next: EditorLayout) => {
        if (grouped && pane !== 'active') {
            setWorkspacePaneLayout(pane, next);
            return;
        }
        void updateSettings({ preview: { layout: next } });
    };
    const sources = useMemo(() => ({
        notes: () => Object.values(notes)
            .filter((n) => !n.deletedAt && n.id !== note?.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 300)
            .map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })),
        tags: () => tags.map((t) => ({ name: t.name, count: t.count })),
    }), [notes, tags, note?.id]);
    const handlers = useMemo(() => ({
        uploadFile: async (file: File) => {
            try {
                const optimized = await optimizeImageFile(file);
                const uploaded = await api.files.upload(optimized, note?.id);
                return {
                    url: uploaded.url,
                    filename: uploaded.filename,
                    isImage: uploaded.mime.startsWith('image/'),
                };
            }
            catch (err) {
                toast({
                    title: t("workspace.upload_failed"),
                    description: err instanceof Error ? err.message : String(err),
                    tone: 'danger',
                });
                return null;
            }
        },
        replaceDetachedUpload: (placeholder: string, replacement: string) => {
            const noteId = note?.id;
            if (!noteId)
                return;
            const state = useNotes.getState();
            const source = state.contents[noteId];
            const at = source?.indexOf(placeholder) ?? -1;
            if (source === undefined || at < 0)
                return;
            state.editContent(noteId, `${source.slice(0, at)}${replacement}${source.slice(at + placeholder.length)}`);
        },
    }), [note?.id, toast]);
    const onChange = useCallback((next: string) => {
        if (!note)
            return;
        editContent(note.id, next);
    }, [note, editContent]);
    const runEditorCommand = useCallback((command: (target: EditorView) => boolean) => {
        if (!view)
            return;
        command(view);
        if (!view.dom.querySelector('.ink-note-search')?.contains(document.activeElement)) view.focus();
    }, [view]);
    const invalidateSyncAnchors = useSyncScroll(view, previewScrollerRef, settings.preview.syncScroll && showSplit);
    const jumpToHeading = useCallback((heading: Heading) => {
        if (view && showEditor) {
            const line = Math.min(view.state.doc.lines, heading.line + 1);
            const pos = view.state.doc.line(line).from;
            view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            view.focus();
        }
        const target = previewScrollerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(heading.slug)}`);
        target?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start', inline: 'nearest' });
    }, [view, showEditor]);
    useEffect(() => {
        if (!note || !paneActive || !showEditor)
            return;
        const frame = window.requestAnimationFrame(() => {
            if (!isMobile && document.activeElement?.closest('[data-note-list]'))
                return;
            if (!note.title)
                titleInputRef.current?.focus();
            else if (!isMobile)
                view?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [note?.id, paneActive, view, showEditor, isMobile]);
    if (!note)
        return <NoNoteSelected onCreate={() => void createContextualNote()}/>;
    if (!loaded) {
        return (<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-editor)]" aria-busy={!loadError}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
          {isMobile && onMobileBack && <IconButton label={t("workspace.back_to_notes")} size="sm" onClick={onMobileBack}><ArrowLeft size={16}/></IconButton>}
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{note.title || t("common.untitled_note")}</span>
          {grouped && pane === 'secondary' && <IconButton label={t("workspace.close_right_note")} size="sm" onClick={closeSecondaryNote}><X size={15}/></IconButton>}
        </header>
        <div role="status" className="flex items-center gap-3 px-5 py-4 text-[13px] text-[var(--text-secondary)]">
          <span>{loadError || t("workspace.loading_note_content")}</span>
          {loadError && <Button size="sm" variant="secondary" onClick={() => void useNotes.getState().openNote(note.id, pane === 'active' ? undefined : { pane, activate: paneActive })}>{t("common.retry")}</Button>}
        </div>
        {!loadError && <div className="min-h-0 flex-1 overflow-hidden"><EditorSkeleton /></div>}
      </div>);
    }
    const noteFolder = note.folderId ? folders.find((folder) => folder.id === note.folderId) ?? null : null;
    const noteFolderPath = note.folderId ? folderPathLabel(folders, note.folderId) : '';
    const exportNote = async (format: 'md' | 'html' | 'pdf') => {
        setExportMenuOpen(false);
        if (!note)
            return;
        await runNoteExport(format, { title: note.title, content }, locale);
    };
    const exportMenuItems: MenuItem[] = [
        { id: 'md', label: t("workspace.export_markdown"), icon: <FileText size={13}/>, onSelect: () => void exportNote('md') },
        { id: 'html', label: t("workspace.export_html"), icon: <FileCode size={13}/>, onSelect: () => void exportNote('html') },
        { id: 'pdf', label: t("workspace.export_pdf"), icon: <FileDown size={13}/>, onSelect: () => void exportNote('pdf') },
    ];
    // 移动端菜单项没有悬停提示的位置，改为「可点但弹说明」；桌面端仍保持禁用 + tooltip。
    const runServerOnly = (run: () => void) => runServerOnlyAction(serverOnlyReason, (title) => toast({ title }), run);
    const serverOnlyItem = (id: string, label: string, icon: MenuItem['icon'], run: () => void): MenuItem => isMobile
        ? { id, label, icon, onSelect: () => runServerOnly(run) }
        : { id, label, icon, disabled: serverOnlyDisabled, onSelect: run };
    const mobileItems: MenuItem[] = [
        ...(isMobile ? [
            { id: 'star', label: note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites"), checked: note.isStarred, onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }) },
            { id: 'backlinks', label: t("common.backlinks"), checked: backlinksOpen, onSelect: () => runServerOnly(toggleBacklinks) },
        ] : []),
        serverOnlyItem('versions', t("common.version_history"), <History size={13}/>, () => openPanel('versions')),
        serverOnlyItem('share', t("workspace.share"), <Share2 size={13}/>, () => openPanel('share')),
        {
            id: 'export-md',
            label: t("workspace.export_markdown"),
            icon: <FileText size={13}/>,
            onSelect: () => void exportNote('md'),
        },
        {
            id: 'export-html',
            label: t("workspace.export_html"),
            icon: <FileCode size={13}/>,
            onSelect: () => void exportNote('html'),
        },
        {
            id: 'export-pdf',
            label: t("workspace.export_pdf"),
            icon: <FileDown size={13}/>,
            onSelect: () => void exportNote('pdf'),
        },
    ];
    const groupedItems: MenuItem[] = [
        { id: 'layout-live', label: t("workspace.editing_mode"), checked: layout === 'live', onSelect: () => setEditorLayout('live') },
        { id: 'layout-split', label: t("workspace.split_view"), checked: layout === 'split', onSelect: () => setEditorLayout('split') },
        { id: 'layout-preview', label: t("workspace.reading_mode"), checked: layout === 'preview', onSelect: () => setEditorLayout('preview') },
        {
            id: 'star',
            label: note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites"),
            icon: <Star size={13}/>,
            separatorBefore: true,
            onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }),
        },
        {
            id: 'backlinks',
            label: t("common.backlinks"),
            icon: <LinkIcon size={13}/>,
            checked: backlinksOpen && paneActive,
            onSelect: toggleBacklinks,
        },
        {
            id: 'outline',
            label: t("common.outline"),
            icon: <ListTree size={13}/>,
            checked: outlineOpen && paneActive,
            onSelect: toggleOutline,
        },
        ...mobileItems,
    ];
    const activatePane = () => {
        if (grouped && pane !== 'active' && !paneActive)
            activateWorkspacePane(pane);
    };
    // 移动端进入式头部与 components/overlay-header.tsx 的 back 形态同一套尺寸（h-11 / px-3 / 32×32 按钮 / 16 图标）。
    // 这里标题是可编辑输入框，不能直接用该组件，改任一边时需同步。
    return (<div role={grouped ? 'region' : undefined} aria-label={grouped ? (pane === 'secondary' ? t("workspace.right_note_pane") : t("workspace.left_note_pane")) : undefined} data-workspace-pane={grouped ? pane : undefined} onPointerDownCapture={activatePane} onFocusCapture={activatePane} className={cn('flex h-full min-h-0 flex-col bg-[var(--bg-editor)]', grouped && paneActive && 'shadow-[inset_0_2px_0_var(--accent)]')}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        {isMobile && onMobileBack && (<Tooltip label={t("workspace.back_to_notes")} side="right">
            <IconButton label={t("workspace.back_to_notes")} size="sm" onClick={onMobileBack}>
              <ArrowLeft size={16}/>
            </IconButton>
          </Tooltip>)}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {readingMobile ? (<h1 aria-label={t("workspace.note_title")} className="min-w-0 flex-1 truncate px-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {note.title || <span className="font-medium text-[var(--text-quaternary)]">{t("common.untitled_note")}</span>}
            </h1>) : (<input
            ref={titleInputRef}
            type="text"
            value={note.title}
            maxLength={LIMITS.titleMaxLength}
            aria-label={t("workspace.note_title")}
            placeholder={t("common.untitled_note")}
            className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] outline-none transition-colors placeholder:font-medium placeholder:text-[var(--text-quaternary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)]"
            onChange={(event) => editTitle(note.id, event.target.value)}
            onBlur={(event) => editTitle(note.id, event.currentTarget.value.trim())}
            onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (view) view.focus();
                else event.currentTarget.blur();
            }}
          />)}
          {note.isStarred && <Star size={11} className="shrink-0 fill-current text-[var(--warning)]"/>}
          {!grouped && (<span className="hidden shrink-0 text-[11px] text-[var(--text-quaternary)] md:inline">
              {updatedTime}
            </span>)}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {layout === 'live' && (<button
            type="button"
            role="switch"
            aria-label={t("workspace.live_preview")}
            aria-checked={livePreviewEnabled}
            onClick={() => void updateSettings({ editor: { livePreview: !livePreviewEnabled } })}
            className="mr-1 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] md:h-7"
          >
            <span className="hidden md:inline">{t("workspace.live_preview")}</span>
            <span aria-hidden="true" className={cn('relative h-3.5 w-6 shrink-0 rounded-full transition-colors', livePreviewEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]')}>
              <span className={cn('absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform', livePreviewEnabled && 'translate-x-2.5')}/>
            </span>
          </button>)}
          {isMobile && (<Tooltip label={readingMobile ? t("workspace.editing_mode") : t("workspace.reading_mode")} side="bottom">
              <IconButton label={readingMobile ? t("workspace.editing_mode") : t("workspace.reading_mode")} size="sm" active={!readingMobile} onClick={() => setNoteView(readingMobile ? 'edit' : 'read')}>
                {readingMobile ? <Pencil size={15}/> : <Eye size={15}/>}
              </IconButton>
            </Tooltip>)}
          {grouped ? (<>
            <div className="mr-1 hidden 2xl:block">
              <Segmented label={t("workspace.layout")} size="sm" value={layout} onChange={setEditorLayout} options={[
            { value: 'live', label: <Pencil size={12.5}/>, title: t("workspace.editing_mode") },
                { value: 'split', label: <Columns2 size={12.5}/>, title: t("workspace.split_view") },
                { value: 'preview', label: <Eye size={12.5}/>, title: t("workspace.reading_mode") },
              ]}/>
            </div>
            <Tooltip label={t("common.more_actions")} side="left">
              <IconButton ref={moreButtonRef} label={t("common.more_actions")} size="sm" onClick={() => setMoreMenuOpen(true)}>
                <MoreHorizontal size={16}/>
              </IconButton>
            </Tooltip>
            {pane === 'secondary' && (<Tooltip label={t("workspace.close_right_note")} side="left">
                <IconButton label={t("workspace.close_right_note")} size="sm" onClick={closeSecondaryNote}>
                  <X size={15}/>
                </IconButton>
              </Tooltip>)}
          </>) : (<>
          <span className="mr-1 hidden xl:inline-flex">
            <SaveIndicator />
          </span>
          <div className={isMobile ? 'hidden' : 'mr-1'}>
            <Segmented label={t("workspace.layout")} size="sm" value={layout} onChange={setEditorLayout} options={[
            { value: 'live', label: <Pencil size={12.5}/>, title: t("workspace.editing_mode") },
            { value: 'split', label: <Columns2 size={12.5}/>, title: t("workspace.split_view") },
            { value: 'preview', label: <Eye size={12.5}/>, title: t("workspace.reading_mode") },
        ]}/>
          </div>
          {!isMobile && <><Tooltip label={note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites")} combo={APP_SHORTCUTS.star}>
            <IconButton label={note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites")} size="sm" active={note.isStarred} onClick={() => void patchNote(note.id, { isStarred: !note.isStarred })}>
              <Star size={14} className={note.isStarred ? 'fill-current' : undefined}/>
            </IconButton>
          </Tooltip>
          <Tooltip label={isDraftNote ? t("notes.draft_unavailable") : t("common.backlinks")} disabled={isDraftNote}>
            <IconButton label={t("common.backlinks")} size="sm" active={backlinksOpen} disabled={isDraftNote} onClick={toggleBacklinks}>
              <LinkIcon size={14}/>
            </IconButton>
          </Tooltip>
          </>}
          {!isMobile && (<Tooltip label={serverOnlyReason ?? t("common.version_history")} disabled={serverOnlyDisabled}>
              <IconButton label={t("common.version_history")} size="sm" disabled={serverOnlyDisabled} onClick={() => openPanel('versions')}>
                <History size={14}/>
              </IconButton>
            </Tooltip>)}
          {!isMobile && (<>
              <Tooltip label={t("workspace.export")}>
                <IconButton ref={exportMenuRef} label={t("workspace.export")} size="sm" onClick={() => setExportMenuOpen(true)}>
                  <Download size={14}/>
                </IconButton>
              </Tooltip>
              <Menu anchor={exportMenuRef} open={exportMenuOpen} onClose={() => setExportMenuOpen(false)} items={exportMenuItems} align="end" width={200}/>
            </>)}
          {(<Tooltip label={t("common.outline")} combo={isMobile ? undefined : APP_SHORTCUTS.outline}>
              <IconButton label={t("common.outline")} size="sm" active={isMobile ? mobileOutlineOpen : outlineOpen} onClick={() => isMobile ? setMobileOutlineOpen((open) => !open) : toggleOutline()}>
                {(isMobile ? mobileOutlineOpen : outlineOpen) ? <PanelRightClose size={14}/> : <ListTree size={14}/>}
              </IconButton>
            </Tooltip>)}
          {!isMobile && (<Tooltip label={serverOnlyReason ?? t("workspace.share")} disabled={serverOnlyDisabled}>
              <IconButton label={t("workspace.share")} size="sm" disabled={serverOnlyDisabled} onClick={() => openPanel('share')}>
                <Share2 size={14}/>
              </IconButton>
            </Tooltip>)}
          {isMobile && (<Tooltip label={t("common.more_actions")} side="left">
              <IconButton ref={moreButtonRef} label={t("common.more_actions")} size="sm" onClick={() => setMoreMenuOpen(true)}>
                <MoreHorizontal size={16}/>
              </IconButton>
            </Tooltip>)}
          </>)}
        </div>
      </header>

      {settings.editor.showToolbar && showEditor && (<EditorToolbar runCommand={runEditorCommand} mobile={isMobile} onPickImage={() => fileInputRef.current?.click()}/>)}

      <div ref={containerRef} className={cn("relative flex min-h-0 flex-1", isMobile && "flex-col")} data-editor-layout={layout}>
        {/* visibility keeps the editor measured; display:none would collapse CodeMirror's height cache. */}
        <div inert={!showEditor} aria-hidden={!showEditor} className={cn("min-h-0 min-w-0", !showEditor && "pointer-events-none invisible absolute inset-0")} style={{ width: showSplit && !isMobile ? editorWidth : outlineVisible ? `calc(100% - ${OUTLINE_WIDTH}px)` : '100%', flex: showEditor && isMobile ? 1 : undefined }}>
            <DeferredCodeEditor key={note.id} visible={showEditor} value={content} noteTitle={note.title} live={livePreviewActive} onHeadings={setHeadings} onChange={onChange} settings={settings.editor} sources={sources} handlers={handlers} onReady={onEditorReady}/>
          </div>

        {showSplit && !isMobile && (<SplitResizer label={t("workspace.resize_editor_and_preview_panes")} containerRef={containerRef} ratio={effectiveSplitRatio} onChange={(splitRatio) => setLayout({ splitRatio })} onReset={() => setLayout({ splitRatio: null })}/>)}

        {showPreview && (<div className={cn('flex min-h-0 min-w-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-editor)]', isMobile && layout === 'split' && 'flex-1 border-l-0 border-t', layout === 'preview' && 'flex-1 border-l-0')} style={{ width: layout === 'split' && !isMobile ? previewWidth : '100%' }}>
            <Preview key={note.id} content={content} noteId={note.id} noteTitle={note.title} onHeadings={setHeadings} scrollerRef={previewScrollerRef} onRendered={invalidateSyncAnchors} onInitialRender={(scroller) => restoreReading(scroller, previewReadingKey)} onScroll={(scroller) => saveReadingPosition(scroller, previewReadingKey)} className="min-w-0 flex-1"/>
            {outlineVisible && (<Outline headings={headings} onSelect={jumpToHeading} scrollerRef={previewScrollerRef}/>)}
          </div>)}
        {!showPreview && outlineVisible && <Outline headings={headings} onSelect={jumpToHeading}/>}
      </div>

      {backlinksOpen && paneActive && <BacklinksPanel noteId={note.id}/>}

      <Menu anchor={moreButtonRef} open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} items={grouped ? groupedItems : mobileItems} align="end" width={220}/>
      {isMobile && (<Drawer open={mobileOutlineOpen} onClose={() => setMobileOutlineOpen(false)} side="right" width={320} title={t("common.outline")}>
          <Outline headings={headings} scrollerRef={previewScrollerRef} className="max-h-none w-full self-stretch py-3" onSelect={(heading) => {
                jumpToHeading(heading);
                setMobileOutlineOpen(false);
            }}/>
        </Drawer>)}

      <footer className="flex h-[var(--statusbar-h)] shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-quaternary)]">
        <span className="tabular">{note.wordCount}{t("common.words")}</span>
        <span className="hidden tabular sm:inline">{note.charCount}{t("workspace.characters")}</span>
        <span className="hidden tabular md:inline">{t("common.about")}{readingMinutes(note.wordCount)}{t("common.min")}</span>
        {noteFolder && noteFolderPath && (<Tooltip label={noteFolderPath} side="top">
            <button type="button" onClick={() => openFolderView(folders, noteFolder.id)} className="inline-flex min-w-0 max-w-40 items-center gap-1 truncate rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] md:max-w-48">
              <FolderClosed size={11} className="shrink-0" style={{ color: noteFolder.color ?? undefined }}/>
              <span className="truncate">{noteFolderPath}</span>
            </button>
          </Tooltip>)}
        {note.tags.length > 0 && (<span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {note.tags.slice(0, isMobile ? 2 : 4).map((name) => (<button key={name} type="button" onClick={() => useUi.getState().openView('tag', { tag: name })} className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]">
                <Hash size={9} className="shrink-0" style={{ color: tagColors.get(name) ?? undefined }}/><span className="truncate">{name}</span>
              </button>))}
          </span>)}
        <span className="flex-1"/>
        <span className={cn('hidden', grouped ? '2xl:inline' : 'lg:inline')}>{t("common.created")}{fullTime(note.createdAt)}</span>
      </footer>

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (view && files.length)
                await insertFiles(view, files, handlers);
        }}/>
    </div>);
}
function NoNoteSelected({ onCreate }: {
    onCreate: () => void;
}) {
    return (<div className="flex h-full items-center justify-center bg-[var(--bg-editor)]">
      <Empty art="select" title={t("workspace.choose_a_note_or_write_a_new_one")} description={t("workspace.open_a_note_from_the_list_or_press_shortcut_to_create_one", { shortcut: prettyCombo(APP_SHORTCUTS.newNote).join('+') })} action={<button type="button" onClick={onCreate} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--accent)] px-3.5 text-[12.5px] font-medium text-[var(--accent-contrast)] transition-transform active:translate-y-px">
            <Plus size={14}/>{t("common.new_note")}</button>}/>
    </div>);
}
