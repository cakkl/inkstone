import { useRef, useState } from 'react';
import { Archive, CheckSquare2, Columns2, Copy, FileCode, FileDown, FileText, FolderInput, Link2, Pin, PinOff, RotateCcw, Star, StarOff, Trash2 } from 'lucide-react';
import type { NoteSummary } from '@shared/types';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import type { Breakpoint } from '../../lib/hooks';
import { t, useLocale } from '../../lib/i18n';
import { confirm, type MenuItem } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { exportNote as runNoteExport } from '../../lib/export-note';

export interface NoteMenuActions {
    copy: (kind: 'title' | 'id' | 'link') => void;
    pin: () => void;
    star: () => void;
    duplicate: () => void;
    archive: () => void;
    move: () => void;
    exportAs: (format: 'md' | 'html' | 'pdf') => void;
    trash: () => void;
    restore: () => void;
    purge: () => void;
    openToSide?: () => void;
    multiSelect?: () => void;
}

export function useNoteMenuHandlers(note: NoteSummary, options: {
    onMove: () => void;
    onOpenToSide?: () => void;
    onMultiSelect?: () => void;
}) {
    const toast = useUi((s) => s.toast);
    const locale = useLocale();
    const purgeRef = useRef(false);
    const [purging, setPurging] = useState(false);
    const copyText = async (value: string, message: 'notes.title_copied' | 'notes.id_copied' | 'notes.direct_link_copied') => {
        try {
            await navigator.clipboard.writeText(value);
            toast({ title: t(message), tone: 'success' });
        }
        catch {
            toast({ title: t('preview.could_not_copy'), tone: 'danger' });
        }
    };
    const exportAs = async (format: 'md' | 'html' | 'pdf') => {
        const state = useNotes.getState();
        let content = state.contents[note.id];
        if (content === undefined) {
            await state.openNote(note.id);
            content = useNotes.getState().contents[note.id];
            if (content === undefined) {
                toast({ title: t('workspace.export_failed'), tone: 'danger' });
                return;
            }
        }
        await runNoteExport(format, { title: note.title, content }, locale);
    };
    const purge = async () => {
        if (purgeRef.current)
            return;
        purgeRef.current = true;
        setPurging(true);
        try {
            const ok = await confirm({
                title: t('notes.permanently_delete_this_note'),
                description: t('notes.this_operation_cannot_be_undone'),
                confirmLabel: t('notes.delete_permanently'),
                tone: 'danger',
            });
            if (ok)
                await useNotes.getState().purgeNote(note.id);
        }
        finally {
            purgeRef.current = false;
            setPurging(false);
        }
    };
    const actions: NoteMenuActions = {
        copy: (kind) => {
            if (kind === 'title')
                void copyText(note.title || t('common.untitled_note'), 'notes.title_copied');
            else if (kind === 'id')
                void copyText(note.id, 'notes.id_copied');
            else
                void copyText(new URL(`/n/${encodeURIComponent(note.id)}`, window.location.origin).href, 'notes.direct_link_copied');
        },
        pin: () => void useNotes.getState().patchNote(note.id, { isPinned: !note.isPinned }),
        star: () => void useNotes.getState().patchNote(note.id, { isStarred: !note.isStarred }),
        duplicate: () => void useNotes.getState().duplicateNote(note.id),
        archive: () => void useNotes.getState().patchNote(note.id, { isArchived: !note.isArchived }),
        move: options.onMove,
        exportAs: (format) => void exportAs(format),
        trash: () => void useNotes.getState().deleteNote(note.id),
        restore: () => void useNotes.getState().restoreNote(note.id),
        purge: () => void purge(),
        ...(options.onOpenToSide ? { openToSide: options.onOpenToSide } : {}),
        ...(options.onMultiSelect ? { multiSelect: options.onMultiSelect } : {}),
    };
    return { actions, purging };
}

export function noteMenuItems(note: NoteSummary, options: {
    breakpoint: Breakpoint;
    active: boolean;
    selected: boolean;
    purging: boolean;
    actions: NoteMenuActions;
}): MenuItem[] {
    const { actions, breakpoint, active, selected, purging } = options;
    const copyItems: MenuItem[] = [
        { id: 'copy-title', label: t('notes.copy_title'), icon: <Copy size={13}/>, onSelect: () => actions.copy('title') },
        { id: 'copy-id', label: t('notes.copy_id'), icon: <Copy size={13}/>, onSelect: () => actions.copy('id') },
        { id: 'copy-direct-link', label: t('notes.copy_direct_link'), icon: <Link2 size={13}/>, onSelect: () => actions.copy('link') },
    ];
    if (note.deletedAt) {
        return [
            ...copyItems,
            { id: 'restore', label: t('common.restore'), icon: <RotateCcw size={13}/>, separatorBefore: true, onSelect: actions.restore },
            {
                id: 'purge',
                label: t('notes.delete_permanently'),
                icon: <Trash2 size={13}/>,
                tone: 'danger',
                separatorBefore: true,
                disabled: purging,
                onSelect: actions.purge,
            },
        ];
    }
    return [
        ...copyItems,
        ...(actions.openToSide && breakpoint === 'desktop'
            ? [{ id: 'open-side', label: t('notes.open_to_side'), icon: <Columns2 size={13}/>, separatorBefore: true, onSelect: actions.openToSide } satisfies MenuItem]
            : []),
        ...(actions.multiSelect && breakpoint === 'mobile'
            ? [{ id: 'multi-select', label: t('notes.add_to_selection'), icon: <CheckSquare2 size={13}/>, separatorBefore: true, disabled: selected, onSelect: actions.multiSelect } satisfies MenuItem]
            : []),
        {
            id: 'pin',
            label: note.isPinned ? t('notes.unpin') : t('notes.pin'),
            icon: note.isPinned ? <PinOff size={13}/> : <Pin size={13}/>,
            separatorBefore: breakpoint !== 'desktop' && breakpoint !== 'mobile',
            onSelect: actions.pin,
        },
        {
            id: 'star',
            label: note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites'),
            icon: note.isStarred ? <StarOff size={13}/> : <Star size={13}/>,
            combo: active ? APP_SHORTCUTS.star : undefined,
            onSelect: actions.star,
        },
        { id: 'duplicate', label: t('notes.create_a_copy'), icon: <Copy size={13}/>, onSelect: actions.duplicate },
        {
            id: 'archive',
            label: note.isArchived ? t('common.unarchive') : t('navigation.archive'),
            icon: <Archive size={13}/>,
            onSelect: actions.archive,
        },
        { id: 'move', label: t('notes.move_to_folder'), icon: <FolderInput size={13}/>, separatorBefore: true, onSelect: actions.move },
        { id: 'export-md', label: t('workspace.export_markdown'), icon: <FileText size={13}/>, separatorBefore: true, onSelect: () => actions.exportAs('md') },
        { id: 'export-html', label: t('workspace.export_html'), icon: <FileCode size={13}/>, onSelect: () => actions.exportAs('html') },
        { id: 'export-pdf', label: t('workspace.export_pdf'), icon: <FileDown size={13}/>, onSelect: () => actions.exportAs('pdf') },
        {
            id: 'delete',
            label: t('common.move_to_trash'),
            icon: <Trash2 size={13}/>,
            tone: 'danger',
            separatorBefore: true,
            onSelect: actions.trash,
        },
    ];
}
