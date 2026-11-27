import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Note, SyncResponse } from '@shared/types'

const mocks = vi.hoisted(() => ({
  queue: [] as any[], folders: [] as any[], patches: [] as any[],
  get: vi.fn(), patch: vi.fn(), create: vi.fn(), remove: vi.fn(), restore: vi.fn(), sync: vi.fn(),
  folderCreate: vi.fn(), folderPatch: vi.fn(), folderRemove: vi.fn(),
}))
vi.mock('../lib/db', () => ({
  SHELL_VERSION: 2,
  localDb: {
    scheduleShellSave: vi.fn(), setContent: vi.fn(async () => {}), dropContent: vi.fn(async () => {}),
    getContent: vi.fn(async () => undefined),
    getOutbox: async () => mocks.queue,
    getFolderOutbox: async () => mocks.folders,
    enqueueFolderOutbox: async (item: any) => {
      mocks.folders = [...mocks.folders.filter((entry) => entry.id !== item.id), item]
    },
    completeFolderOutboxItem: async (id: string) => {
      mocks.folders = mocks.folders.filter((entry) => entry.id !== id)
    },
    clearFolderOutboxForFolder: async (folderId: string) => {
      mocks.folders = mocks.folders.filter((entry) => entry.folderId !== folderId)
    },
    markFolderOutboxFailure: async (id: string) => {
      mocks.folders = mocks.folders.map((entry) => entry.id === id
        ? { ...entry, attempts: (entry.attempts ?? 0) + 1, nextAttemptAt: Date.now() + 1000 } : entry)
    },
    getNotePatchOutbox: async () => mocks.patches,
    mergeNotePatchOutbox: async (noteId: string, kind: string, patch: Record<string, unknown>) => {
      const previous = mocks.patches.find((entry: any) => entry.noteId === noteId)
      const rest = mocks.patches.filter((entry: any) => entry.noteId !== noteId)
      if (previous && ((previous.kind === 'delete' && kind === 'restore') || (previous.kind === 'restore' && kind === 'delete'))) {
        mocks.patches = rest
        return
      }
      mocks.patches = [
        ...rest,
        { noteId, kind, patch: { ...previous?.patch, ...patch }, createdAt: previous?.createdAt ?? Date.now() },
      ]
    },
    completeNotePatchOutbox: async (noteId: string) => {
      mocks.patches = mocks.patches.filter((entry: any) => entry.noteId !== noteId)
    },
    enqueueOutbox: async (item: any) => { mocks.queue = [...mocks.queue.filter((q) => q.id !== item.id), item] },
    completeOutboxItem: async (id: string, writeId: string) => {
      mocks.queue = mocks.queue.filter((q) => q.id !== id || q.writeId !== writeId)
    },
    setOutboxRecoveryId: async (id: string, writeId: string, recoveryId: string) => {
      mocks.queue = mocks.queue.map((q) => q.id === id && q.writeId === writeId
        ? { ...q, payload: { ...q.payload, recoveryId } } : q)
    },
    advanceOutboxDependents: vi.fn(async () => {}), markOutboxFailure: vi.fn(async () => {}),
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => { await task(); return true },
  }, publishBroadcast: vi.fn(),
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<any>('../lib/api')
  return { ...actual, api: { ...actual.api, sync: mocks.sync, notes: { get: mocks.get, patch: mocks.patch, create: mocks.create, remove: mocks.remove, restore: mocks.restore }, folders: { create: mocks.folderCreate, patch: mocks.folderPatch, remove: mocks.folderRemove } } }
})
import { useNotes } from './notes'
import { prefetchRecentContents } from './notes'
import { useUi } from './ui'
import { ApiError } from '../lib/api'

const note: Note = {
  id: '01m1r8923zajxnw9y0dhs6sy8j', title: 'Example', excerpt: 'old', content: 'old',
  folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false,
  wordCount: 1, charCount: 3, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}
function sync(remote: Note): SyncResponse {
  const { content: _content, ...summary } = remote
  return { cursor: remote.rev, full: false, hasMore: false, nextKey: null, facetsFull: false,
    settingsChanged: false, profileChanged: false, siteChanged: false, notes: [summary],
    folders: [], tags: [], deletions: [], serverTime: 1 }
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.queue = []
  mocks.folders = []
  mocks.patches = []
  mocks.get.mockReset(); mocks.patch.mockReset(); mocks.create.mockReset()
  mocks.folderCreate.mockReset(); mocks.folderPatch.mockReset(); mocks.folderRemove.mockReset();
  mocks.remove.mockReset(); mocks.restore.mockReset()
  mocks.sync.mockReset()
  mocks.sync.mockRejectedValue(new Error('sync is unavailable in this test'))
  mocks.get.mockResolvedValue({ ...note })
  useNotes.setState({ notes: { [note.id]: note }, contents: { [note.id]: note.content },
    folders: [], tags: [], links: {}, cursor: 1, pendingCount: 0, online: true, drafts: new Set<string>() })
  useUi.setState({ activeNoteId: null, workspacePrimaryNoteId: null, workspaceSecondaryNoteId: null })
})
afterEach(() => vi.useRealTimers())

it('keeps the loaded content revision until remote content arrives', async () => {
  let resolve!: (value: Note) => void
  mocks.get.mockImplementation(() => new Promise<Note>((done) => { resolve = done }))
  const remote = { ...note, rev: 2, content: 'remote edit' }
  useNotes.getState().applySync(sync(remote))
  expect(useNotes.getState().notes[note.id].rev).toBe(1)
  expect(useNotes.getState().contents[note.id]).toBe('old')
  expect(mocks.get).toHaveBeenCalledWith(note.id)
  resolve(remote)
  await vi.waitFor(() => expect(useNotes.getState().contents[note.id]).toBe('remote edit'))
  expect(useNotes.getState().notes[note.id].rev).toBe(2)
})

it('saves conflicting local edits as a copy without retrying over the server note', async () => {
  useNotes.getState().editContent(note.id, 'offline local edit')
  const remote = { ...note, rev: 3, content: 'remote important edit' }
  mocks.patch.mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict', { server: remote }))
  mocks.create.mockImplementation(async (input) => ({ ...note, ...input, rev: 1 }))
  await useNotes.getState().flush({ immediate: true })
  expect(mocks.patch).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ content: 'offline local edit' }))
  expect(useNotes.getState().contents[note.id]).toBe('remote important edit')
  expect(useNotes.getState().notes[note.id].rev).toBe(3)
  expect(mocks.queue).toHaveLength(0)
})

it('keeps an empty new note local until it has content', async () => {
  const id = await useNotes.getState().createNote({ open: false })
  expect(id).toBeTruthy()
  expect(mocks.create).not.toHaveBeenCalled()
  expect(useNotes.getState().drafts.has(id!)).toBe(true)
  expect(useNotes.getState().notes[id!]).toBeTruthy()
})

it('uploads a draft as soon as it has a title', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  mocks.create.mockImplementation(async (input: any) => ({ ...note, ...input, rev: 1, id }))
  useNotes.getState().editTitle(id, 'New title')
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id, title: 'New title', content: '' }))
  expect(useNotes.getState().drafts.has(id)).toBe(false)
})

it('keeps a blank draft local while the body has no text', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  useNotes.getState().editContent(id, '   ')
  await vi.waitFor(() => expect(useNotes.getState().contents[id]).toBe('   '))
  expect(mocks.create).not.toHaveBeenCalled()
  expect(useNotes.getState().drafts.has(id)).toBe(true)
})

it('counts a draft as pending once it holds text the server never received', async () => {
  mocks.create.mockRejectedValue(new ApiError(0, 'offline', 'no network'))
  useNotes.setState({ online: false })
  const id = (await useNotes.getState().createNote({ open: false }))!
  await useNotes.getState().flush({ immediate: true })
  expect(useNotes.getState().pendingCount).toBe(0)

  useNotes.getState().editTitle(id, 'offline draft')
  await vi.waitFor(() => expect(useNotes.getState().pendingCount).toBe(1))
  expect(useNotes.getState().drafts.has(id)).toBe(true)
})

it('applies draft patches locally without hitting the server', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  await useNotes.getState().patchNote(id, { isPinned: true, isStarred: true })
  expect(useNotes.getState().notes[id]).toMatchObject({ isPinned: true, isStarred: true })
  expect(mocks.patch).not.toHaveBeenCalled()
})

it('deletes a draft locally and offers an in-memory undo', async () => {
  const toast = vi.fn()
  useUi.setState({ toast })
  const id = (await useNotes.getState().createNote({ open: false }))!
  await useNotes.getState().deleteNote(id)
  expect(useNotes.getState().notes[id]).toBeUndefined()
  expect(useNotes.getState().drafts.has(id)).toBe(false)
  expect(mocks.patch).not.toHaveBeenCalled()
  const action = toast.mock.calls[0][0].action
  expect(action).toBeTruthy()
  action.run()
  expect(useNotes.getState().notes[id]).toBeTruthy()
  expect(useNotes.getState().drafts.has(id)).toBe(true)
})

it('keeps drafts across a full sync that omits them', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  useNotes.getState().applySync({ ...sync(note), notes: [], cursor: 5, full: true })
  expect(useNotes.getState().notes[id]).toBeTruthy()
})

it('discards a blank draft when switching to another note', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  useUi.setState({ activeNoteId: id, workspacePrimaryNoteId: id })
  useUi.setState({ activeNoteId: note.id, workspacePrimaryNoteId: note.id })
  expect(useNotes.getState().notes[id]).toBeUndefined()
  expect(useNotes.getState().drafts.has(id)).toBe(false)
})

it('keeps a draft that already has text when switching away', async () => {
  const id = (await useNotes.getState().createNote({ open: false }))!
  useNotes.getState().editTitle(id, 'kept')
  useUi.setState({ activeNoteId: id, workspacePrimaryNoteId: id })
  useUi.setState({ activeNoteId: note.id, workspacePrimaryNoteId: note.id })
  expect(useNotes.getState().notes[id]).toBeTruthy()
})

it('queues folder creation while offline and replays it once back online', async () => {
  mocks.folderCreate.mockImplementation(async (input: any) => ({
    id: input.id, parentId: input.parentId ?? null, name: input.name,
    icon: null, color: null, position: 1000, createdAt: 1, updatedAt: 1, noteCount: 0,
  }))
  useNotes.setState({ online: false })
  const id = useNotes.getState().createFolder({ name: 'offline folder' })
  expect(id).toBeTruthy()
  expect(mocks.folderCreate).not.toHaveBeenCalled()
  expect(useNotes.getState().folders.some((folder) => folder.id === id)).toBe(true)
  expect(mocks.folders).toHaveLength(1)

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.folderCreate).toHaveBeenCalledTimes(1)
  expect(mocks.folders).toHaveLength(0)
  expect(useNotes.getState().folders.some((folder) => folder.id === id)).toBe(true)
})

it('keeps the queued folder when replaying while still offline', async () => {
  mocks.folderCreate.mockRejectedValue(new ApiError(0, 'offline', 'no network'))
  useNotes.setState({ online: false })
  const id = useNotes.getState().createFolder({ name: 'offline folder' })
  await useNotes.getState().replayPending()
  expect(mocks.folders).toHaveLength(1)
  expect(useNotes.getState().folders.some((folder) => folder.id === id)).toBe(true)
  expect(useNotes.getState().online).toBe(false)
})

it('queues note field changes while offline and replays them back online', async () => {
  mocks.patch.mockResolvedValue({ ...note, isStarred: true, rev: 2 })
  useNotes.setState({ online: false })
  await useNotes.getState().patchNote(note.id, { isStarred: true })

  expect(mocks.patch).not.toHaveBeenCalled()
  expect(useNotes.getState().notes[note.id]).toMatchObject({ isStarred: true })
  expect(mocks.patches).toHaveLength(1)

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.patch).toHaveBeenCalledTimes(1)
  expect(mocks.patches).toHaveLength(0)
  expect(useNotes.getState().notes[note.id]).toMatchObject({ isStarred: true, rev: 2 })
})

it('merges repeated offline field changes into one queued patch', async () => {
  useNotes.setState({ online: false })
  await useNotes.getState().patchNote(note.id, { isStarred: true })
  await useNotes.getState().patchNote(note.id, { isPinned: true })
  expect(mocks.patches).toHaveLength(1)
  expect(mocks.patches[0].patch).toMatchObject({ isStarred: true, isPinned: true })
})

it('queues note deletion while offline and replays it back online', async () => {
  mocks.remove.mockResolvedValue({ ...note, deletedAt: Date.now() })
  useNotes.setState({ online: false })
  await useNotes.getState().deleteNote(note.id)

  expect(useNotes.getState().notes[note.id].deletedAt).toBeTruthy()
  expect(mocks.patches).toHaveLength(1)
  expect(mocks.patches[0].kind).toBe('delete')

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()
  expect(mocks.remove).toHaveBeenCalledTimes(1)
  expect(mocks.patches).toHaveLength(0)
})

it('drops the queued deletion when the note is restored before it syncs', async () => {
  useNotes.setState({ online: false })
  await useNotes.getState().deleteNote(note.id)
  expect(mocks.patches).toHaveLength(1)
  await useNotes.getState().restoreNote(note.id)
  expect(mocks.patches).toHaveLength(0)
  expect(useNotes.getState().notes[note.id].deletedAt).toBeNull()
})

it('keeps an offline deletion applied when a sync pull returns the untouched note', async () => {
  useNotes.setState({ online: false })
  await useNotes.getState().deleteNote(note.id)
  useNotes.getState().applySync(sync({ ...note, deletedAt: null }))
  expect(useNotes.getState().notes[note.id].deletedAt).toBeTruthy()
})

it('keeps an offline restore applied when a sync pull still reports the note as trashed', async () => {
  useNotes.setState({ notes: { [note.id]: { ...note, deletedAt: 5 } }, online: false })
  await useNotes.getState().restoreNote(note.id)
  useNotes.getState().applySync(sync({ ...note, deletedAt: 5, rev: 2 }))
  expect(useNotes.getState().notes[note.id].deletedAt).toBeNull()
})

it('replays a queued field change against the server revision after a conflict', async () => {
  useNotes.setState({ online: false })
  await useNotes.getState().patchNote(note.id, { isStarred: true })
  const server = { ...note, rev: 2, isPinned: true }
  mocks.patch
    .mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict', { server }))
    .mockResolvedValueOnce({ ...server, rev: 3, isStarred: true })

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.patch).toHaveBeenCalledTimes(2)
  expect(mocks.patch.mock.calls[1][1]).toMatchObject({ rev: 2, isStarred: true })
  expect(mocks.patches).toHaveLength(0)
  expect(useNotes.getState().notes[note.id]).toMatchObject({ isStarred: true, isPinned: true, rev: 3 })
})

it('treats a queued deletion as done when the server already trashed the note', async () => {
  useNotes.setState({ online: false })
  await useNotes.getState().deleteNote(note.id)
  mocks.remove.mockRejectedValue(new ApiError(409, 'conflict', 'conflict', {
    server: { ...note, rev: 2, deletedAt: 5000 },
  }))

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.remove).toHaveBeenCalledTimes(1)
  expect(mocks.patches).toHaveLength(0)
  expect(useNotes.getState().notes[note.id].deletedAt).toBe(5000)
})

it('retries a queued folder creation once after a conflict', async () => {
  mocks.folderCreate
    .mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict'))
    .mockImplementationOnce(async (input: any) => ({
      id: input.id, parentId: input.parentId ?? null, name: input.name,
      icon: null, color: null, position: 1000, createdAt: 1, updatedAt: 1, noteCount: 0,
    }))
  useNotes.setState({ online: false })
  const id = useNotes.getState().createFolder({ name: 'offline folder' })

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.folderCreate).toHaveBeenCalledTimes(2)
  expect(mocks.folders).toHaveLength(0)
  expect(useNotes.getState().folders.some((folder) => folder.id === id)).toBe(true)
})

it('keeps the synced link index so backlinks survive offline', async () => {
  const target = '01m1r8923zajxnw9y0dhs6sy9k'
  useNotes.getState().applySync({
    ...sync(note),
    links: [{ sourceId: note.id, targetKey: 'target note', targetTitle: 'Target note', targetId: target }],
  })
  expect(useNotes.getState().links[note.id]).toHaveLength(1)

  useNotes.getState().applySync({ ...sync(note), notes: sync(note).notes, links: [] })
  expect(useNotes.getState().links[note.id]).toBeUndefined()
})

it('prefetches recent note bodies only while online', async () => {
  const other = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9m', updatedAt: 20 }
  useNotes.setState({ notes: { [note.id]: note, [other.id]: other }, contents: {}, online: false })
  await prefetchRecentContents(() => useNotes.getState())
  expect(mocks.get).not.toHaveBeenCalled()

  mocks.get.mockImplementation(async (id: string) => ({ ...note, id, content: 'cached body', rev: 2 }))
  useNotes.setState({ online: true })
  await prefetchRecentContents(() => useNotes.getState())
  expect(mocks.get).toHaveBeenCalledWith(other.id)
})

it('rebuilds the local link index as soon as a note gains a wiki link', async () => {
  const target = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9n', title: 'Target note', createdAt: 5 }
  useNotes.setState({
    notes: { [note.id]: note, [target.id]: target },
    contents: { [note.id]: 'old', [target.id]: 'body' },
  })

  useNotes.getState().editContent(note.id, 'see [[Target note]]')
  await vi.advanceTimersByTimeAsync(400)

  expect(useNotes.getState().links[note.id]?.[0]).toMatchObject({
    sourceId: note.id,
    targetTitle: 'Target note',
    targetId: target.id,
  })
})

it('re-resolves inbound links when the target title changes', async () => {
  const target = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9p', title: 'Old title', createdAt: 5 }
  const source = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9q', title: 'Source' }
  useNotes.setState({
    notes: { [target.id]: target, [source.id]: source },
    contents: { [target.id]: 'body', [source.id]: 'see [[Old title]]' },
    links: {
      [source.id]: [{ sourceId: source.id, targetKey: 'old title', targetTitle: 'Old title', targetId: target.id }],
    },
  })

  useNotes.getState().editTitle(target.id, 'New title')
  await vi.advanceTimersByTimeAsync(400)

  expect(useNotes.getState().links[source.id]?.[0]?.targetId).toBeNull()
})

it('keeps locally resolved links while the server still reports the old copy', async () => {
  const target = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9r', title: 'Target note', createdAt: 5 }
  useNotes.setState({
    notes: { [note.id]: note, [target.id]: target },
    contents: { [note.id]: 'old', [target.id]: 'body' },
  })
  useNotes.getState().editContent(note.id, 'see [[Target note]]')
  await vi.advanceTimersByTimeAsync(400)
  expect(useNotes.getState().links[note.id]).toHaveLength(1)

  useNotes.getState().applySync({ ...sync(note), notes: sync(note).notes, links: [] })
  expect(useNotes.getState().links[note.id]).toHaveLength(1)
})

it('derives tag counts from the local notes instead of the server payload', () => {
  const tagged = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9s', tags: ['Work'] }
  const archived = { ...note, id: '01m1r8923zajxnw9y0dhs6sy9t', tags: ['work'], isArchived: true }
  useNotes.setState({
    notes: { [note.id]: note, [tagged.id]: tagged, [archived.id]: archived },
    tags: [{ id: 't1', name: 'work', color: null, count: 0, createdAt: 1 }],
  })

  useNotes.getState().applySync({ ...sync(note), notes: [], tags: [] })

  expect(useNotes.getState().tags[0]?.count).toBe(1)
})

it('treats a folder the server no longer has as already deleted', async () => {
  const folder = {
    id: 'folder-gone', parentId: null, name: 'Ghost', icon: null, color: null,
    position: 1000, createdAt: 1, updatedAt: 1, noteCount: 0,
  }
  useNotes.setState({ folders: [folder] })
  mocks.folderRemove.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Folder not found'))

  expect(useNotes.getState().deleteFolder(folder.id)).toBe(true)
  await vi.waitFor(() => expect(mocks.folderRemove).toHaveBeenCalledTimes(1))

  expect(useNotes.getState().folders.some((item) => item.id === folder.id)).toBe(false)
})

it('deletes a folder that never reached the server without calling the API', async () => {
  useNotes.setState({ online: false })
  const id = useNotes.getState().createFolder({ name: 'local only' })!
  await vi.waitFor(() => expect(mocks.folders).toHaveLength(1))

  expect(useNotes.getState().deleteFolder(id)).toBe(true)
  await vi.waitFor(() => expect(useNotes.getState().folders.some((item) => item.id === id)).toBe(false))
  await vi.waitFor(() => expect(mocks.folders).toHaveLength(0))

  expect(mocks.folderRemove).not.toHaveBeenCalled()
})

it('keeps a queued folder when replaying fails so it can retry later', async () => {
  useNotes.setState({ online: false })
  const id = useNotes.getState().createFolder({ name: 'offline folder' })!
  await vi.waitFor(() => expect(mocks.folders).toHaveLength(1))
  mocks.folderCreate.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'parent folder is gone'))

  useNotes.setState({ online: true })
  await useNotes.getState().replayPending()

  expect(mocks.folders).toHaveLength(1)
  expect(useNotes.getState().folders.some((item) => item.id === id)).toBe(true)
})

it('keeps local summary fields when a write response omits them', async () => {
  const stored = {
    ...note,
    summary: { text: 'saved text', origin: 'ai' as const, status: 'current' as const, updatedAt: 9 },
    summarySettings: { summaryEnabled: false, aiMode: 'inherit' as const, autoGenerate: null },
  }
  useNotes.setState({ notes: { [note.id]: stored }, contents: { [note.id]: note.content } })
  mocks.patch.mockResolvedValue({ ...note, isStarred: true, rev: 2, summary: undefined, summarySettings: undefined })

  await useNotes.getState().patchNote(note.id, { isStarred: true })
  await vi.waitFor(() => expect(useNotes.getState().notes[note.id].rev).toBe(2))

  expect(useNotes.getState().notes[note.id].summarySettings).toEqual(stored.summarySettings)
  expect(useNotes.getState().notes[note.id].summary?.text).toBe('saved text')
})
