import type { NoteSummary, SyncLink } from '@shared/types'
import { extractWikiLinks, normalizeLinkKey } from '@shared/markdown-utils'

export function buildTitleIndex(notes: Record<string, NoteSummary>): Map<string, string> {
    const index = new Map<string, { id: string; createdAt: number }>()
    for (const note of Object.values(notes)) {
        if (note.deletedAt)
            continue
        const key = normalizeLinkKey(note.title)
        if (!key)
            continue
        const current = index.get(key)
        if (!current || note.createdAt < current.createdAt ||
            (note.createdAt === current.createdAt && note.id < current.id))
            index.set(key, { id: note.id, createdAt: note.createdAt })
    }
    const result = new Map<string, string>()
    for (const [key, value] of index)
        result.set(key, value.id)
    return result
}

export function linksForContent(noteId: string, content: string, index: Map<string, string>): SyncLink[] {
    return extractWikiLinks(content).map((link) => ({
        sourceId: noteId,
        targetKey: link.key,
        targetTitle: link.target,
        targetId: index.get(link.key) ?? null,
    }))
}
