import type { Folder, GraphEdge, GraphNode, GraphQuery, GraphResponse, NoteSummary, SyncLink, Tag } from '@shared/types'
import { wikiNoteTarget } from '@shared/markdown-utils'

const EDGE_CANDIDATE_LIMIT = 10_000
const UNRESOLVED_LIMIT = 50

export interface GraphSource {
    notes: Record<string, NoteSummary>
    links: Record<string, SyncLink[]>
    folders: Folder[]
    tags: Tag[]
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    const parsed = Number.isFinite(value) ? Math.trunc(value as number) : fallback
    return Math.min(max, Math.max(min, parsed))
}

function byText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

export function buildGraph(query: GraphQuery, source: GraphSource): GraphResponse {
    const mode = query.mode === 'local' ? 'local' : 'global'
    const depth = clamp(query.depth, 1, 3, 1)
    const limit = clamp(query.limit, 50, 600, 350)
    const centerId = mode === 'local' ? query.center ?? null : null
    const includeOrphans = query.includeOrphans !== false
    const includeUnresolved = query.includeUnresolved === true
    const needle = (query.q ?? '').trim().toLowerCase()
    const folderId = query.folderId ?? ''
    const tagName = (query.tag ?? '').trim().toLowerCase()

    const outDegree = new Map<string, number>()
    const inDegree = new Map<string, number>()
    const inDegreeWithoutSelf = new Map<string, number>()
    const adjacency = new Map<string, string[]>()
    const connected = new Set<string>()
    for (const [sourceId, group] of Object.entries(source.links)) {
        for (const link of group) {
            const targetId = link.targetId
            if (!targetId)
                continue
            outDegree.set(sourceId, (outDegree.get(sourceId) ?? 0) + 1)
            inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1)
            if (targetId !== sourceId)
                inDegreeWithoutSelf.set(targetId, (inDegreeWithoutSelf.get(targetId) ?? 0) + 1)
            connected.add(sourceId)
            connected.add(targetId)
            const forward = adjacency.get(sourceId)
            if (forward)
                forward.push(targetId)
            else
                adjacency.set(sourceId, [targetId])
            const backward = adjacency.get(targetId)
            if (backward)
                backward.push(sourceId)
            else
                adjacency.set(targetId, [sourceId])
        }
    }
    const degreeOf = (id: string): number => (outDegree.get(id) ?? 0) + (inDegreeWithoutSelf.get(id) ?? 0)
    const isVisible = (note: NoteSummary): boolean => !note.deletedAt && !note.isArchived
    const matches = (note: NoteSummary): boolean => {
        if (!isVisible(note))
            return false
        if (needle && !note.title.toLowerCase().includes(needle))
            return false
        if (folderId && note.folderId !== folderId)
            return false
        if (tagName && !note.tags.some((tag) => tag.toLowerCase() === tagName))
            return false
        if (!includeOrphans && !connected.has(note.id))
            return false
        return true
    }

    let totalNodes = 0
    const depths = new Map<string, number>()
    let candidates: NoteSummary[]
    if (mode === 'local') {
        if (centerId && source.notes[centerId]) {
            depths.set(centerId, 0)
            let frontier = [centerId]
            for (let level = 0; level < depth && frontier.length; level++) {
                const next: string[] = []
                for (const id of frontier) {
                    for (const neighbour of adjacency.get(id) ?? []) {
                        if (depths.has(neighbour))
                            continue
                        const note = source.notes[neighbour]
                        if (!note || !isVisible(note))
                            continue
                        depths.set(neighbour, level + 1)
                        next.push(neighbour)
                    }
                }
                frontier = next
            }
        }
        candidates = []
        for (const id of depths.keys()) {
            const note = source.notes[id]
            if (note && matches(note))
                candidates.push(note)
        }
    }
    else {
        candidates = Object.values(source.notes).filter(matches)
    }
    totalNodes = candidates.length
    candidates.sort((left, right) => {
        if (mode === 'local') {
            const leftDepth = depths.get(left.id) ?? 0
            const rightDepth = depths.get(right.id) ?? 0
            if (leftDepth !== rightDepth)
                return leftDepth - rightDepth
        }
        const leftDegree = degreeOf(left.id)
        const rightDegree = degreeOf(right.id)
        if (leftDegree !== rightDegree)
            return rightDegree - leftDegree
        if (left.updatedAt !== right.updatedAt)
            return right.updatedAt - left.updatedAt
        return byText(left.id, right.id)
    })

    const noteLimit = includeUnresolved ? Math.max(1, limit - UNRESOLVED_LIMIT) : limit
    let truncated = totalNodes > noteLimit
    const selected = candidates.slice(0, noteLimit)
    const known = new Set(selected.map((note) => note.id))

    const edges: GraphEdge[] = []
    const seenEdges = new Set<string>()
    const unresolved = new Map<string, { title: string; sources: Set<string> }>()
    let edgeCandidates = 0
    for (const [sourceId, group] of Object.entries(source.links)) {
        if (!known.has(sourceId))
            continue
        for (const link of group) {
            if (!link.targetId) {
                if (!includeUnresolved)
                    continue
                if (unresolved.size >= UNRESOLVED_LIMIT && !unresolved.has(link.targetKey))
                    continue
                const current = unresolved.get(link.targetKey) ?? {
                    title: wikiNoteTarget(link.targetTitle),
                    sources: new Set<string>(),
                }
                current.sources.add(sourceId)
                unresolved.set(link.targetKey, current)
                continue
            }
            if (link.targetId === sourceId || !known.has(link.targetId))
                continue
            const key = `${sourceId}>${link.targetId}`
            if (seenEdges.has(key))
                continue
            if (++edgeCandidates > EDGE_CANDIDATE_LIMIT) {
                truncated = true
                break
            }
            seenEdges.add(key)
            edges.push({ source: sourceId, target: link.targetId })
        }
    }

    const folderById = new Map(source.folders.map((folder) => [folder.id, folder]))
    const tagColor = new Map(source.tags.map((tag) => [tag.name.toLowerCase(), tag.color]))
    const nodes: GraphNode[] = selected.map((note) => {
        const folder = note.folderId ? folderById.get(note.folderId) : undefined
        return {
            id: note.id,
            title: note.title,
            kind: 'note',
            degree: degreeOf(note.id),
            inDegree: inDegree.get(note.id) ?? 0,
            outDegree: outDegree.get(note.id) ?? 0,
            folderId: note.folderId,
            folderName: folder?.name ?? null,
            folderColor: folder?.color ?? null,
            tags: note.tags.map((name) => ({ name, color: tagColor.get(name.toLowerCase()) ?? null })),
        }
    })
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    for (const [key, missing] of unresolved) {
        const id = `unresolved:${key}`
        nodes.push({
            id,
            title: missing.title,
            kind: 'unresolved',
            degree: missing.sources.size,
            inDegree: missing.sources.size,
            outDegree: 0,
            folderId: null,
            folderName: null,
            folderColor: null,
            tags: [],
        })
        for (const sourceId of missing.sources) {
            edges.push({ source: sourceId, target: id })
            const node = nodeById.get(sourceId)
            if (!node)
                continue
            node.degree += 1
            node.outDegree += 1
        }
    }
    if (unresolved.size >= UNRESOLVED_LIMIT)
        truncated = true

    return {
        nodes,
        edges,
        meta: {
            mode,
            centerId,
            depth,
            totalNodes: totalNodes + unresolved.size,
            totalEdges: edges.length,
            truncated,
            limit,
        },
    }
}
