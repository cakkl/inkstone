import { describe, expect, it } from 'vitest'
import type { NoteSummary, SyncLink } from '@shared/types'
import { buildGraph } from './graph'

function note(id: string, title: string, extra: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id, title, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0,
    createdAt: 1, updatedAt: 1, deletedAt: null, ...extra,
  }
}
function link(sourceId: string, targetId: string | null, targetTitle = 'target'): SyncLink {
  return { sourceId, targetId, targetKey: targetTitle.toLowerCase(), targetTitle }
}
function index(...notes: NoteSummary[]): Record<string, NoteSummary> {
  return Object.fromEntries(notes.map((entry) => [entry.id, entry]))
}

describe('buildGraph', () => {
  it('orders the global graph by degree and skips edges between filtered notes', () => {
    const notes = index(note('a', 'A'), note('b', 'B'), note('c', 'C'), note('d', 'Hidden', { isArchived: true }))
    const graph = buildGraph({ mode: 'global' }, {
      notes,
      links: {
        a: [link('a', 'b'), link('a', 'd')],
        b: [link('b', 'c')],
        c: [link('c', 'b')],
      },
      folders: [],
      tags: [],
    })

    expect(graph.nodes.map((node) => node.id)).toEqual(['b', 'a', 'c'])
    expect(graph.nodes[0]).toMatchObject({ id: 'b', degree: 3, inDegree: 2, outDegree: 1 })
    expect(graph.nodes[1]).toMatchObject({ id: 'a', degree: 2, inDegree: 0, outDegree: 2 })
    expect(graph.edges).toEqual([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'b' },
    ])
  })

  it('counts a self link as degree but never draws it as an edge', () => {
    const graph = buildGraph({ mode: 'global' }, {
      notes: index(note('a', 'A')),
      links: { a: [link('a', 'a')] },
      folders: [],
      tags: [],
    })

    expect(graph.edges).toHaveLength(0)
    expect(graph.nodes[0]).toMatchObject({ degree: 1, inDegree: 1, outDegree: 1 })
  })

  it('walks only the requested number of hops for a local graph', () => {
    const notes = index(note('a', 'A'), note('b', 'B'), note('c', 'C'), note('d', 'D'))
    const links = {
      a: [link('a', 'b')],
      b: [link('b', 'c')],
      c: [link('c', 'd')],
    }
    const oneHop = buildGraph({ mode: 'local', center: 'a', depth: 1 }, { notes, links, folders: [], tags: [] })
    expect(oneHop.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])

    const twoHops = buildGraph({ mode: 'local', center: 'a', depth: 2 }, { notes, links, folders: [], tags: [] })
    expect(twoHops.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'c'])
    expect(twoHops.meta.centerId).toBe('a')
  })

  it('drops orphans when the filter asks for them to be hidden', () => {
    const notes = index(note('a', 'A'), note('b', 'B'), note('lonely', 'Lonely'))
    const links = { a: [link('a', 'b')] }
    const withOrphans = buildGraph({ mode: 'global' }, { notes, links, folders: [], tags: [] })
    expect(withOrphans.nodes).toHaveLength(3)

    const withoutOrphans = buildGraph({ mode: 'global', includeOrphans: false }, { notes, links, folders: [], tags: [] })
    expect(withoutOrphans.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
  })

  it('folds unresolved wiki links into bounded placeholder nodes', () => {
    const graph = buildGraph(
      { mode: 'global', includeUnresolved: true },
      {
        notes: index(note('a', 'A')),
        links: { a: [link('a', null, 'Missing note')] },
        folders: [],
        tags: [],
      },
    )

    expect(graph.nodes.map((node) => node.kind)).toEqual(['note', 'unresolved'])
    expect(graph.nodes[1]).toMatchObject({ id: 'unresolved:missing note', title: 'Missing note', degree: 1 })
    expect(graph.edges).toEqual([{ source: 'a', target: 'unresolved:missing note' }])
    expect(graph.nodes[0]).toMatchObject({ degree: 1, outDegree: 1 })
  })

  it('reports truncation when the visible node count exceeds the limit', () => {
    const notes = index(...Array.from({ length: 60 }, (_, index) => note(`n${index}`, `Note ${index}`)))
    const graph = buildGraph({ mode: 'global', limit: 50 }, { notes, links: {}, folders: [], tags: [] })

    expect(graph.nodes).toHaveLength(50)
    expect(graph.meta.totalNodes).toBe(60)
    expect(graph.meta.truncated).toBe(true)
  })
})
