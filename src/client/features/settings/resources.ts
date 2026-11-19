import { api, ApiError } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { createSettingsResource } from './resource'

export const backupTargetsResource = createSettingsResource(async () => (await api.backup.targets()).targets)
export const backupRunsResource = createSettingsResource(async () => (await api.backup.runs()).runs)
export const mcpResource = createSettingsResource(() => api.mcp.get())

export interface DataOverview {
  notes: number
  trashed: number
  folders: number
  tags: number
  links: number
  chars: number
  words: number
  versions: number
  attachments: number
  attachmentBytes: number
}

export function localDataOverview(): DataOverview {
  const state = useNotes.getState()
  let notes = 0
  let trashed = 0
  let chars = 0
  let words = 0
  for (const note of Object.values(state.notes)) {
    if (note.deletedAt) {
      trashed++
      continue
    }
    notes++
    chars += note.charCount
    words += note.wordCount
  }
  let links = 0
  for (const group of Object.values(state.links))
    links += group.length
  return {
    notes,
    trashed,
    folders: state.folders.length,
    tags: state.tags.length,
    links,
    chars,
    words,
    versions: 0,
    attachments: 0,
    attachmentBytes: 0,
  }
}

export const statsResource = createSettingsResource<DataOverview>(async () => {
  const local = localDataOverview()
  try {
    const remote = await api.settings.stats()
    return {
      ...local,
      versions: remote.versions ?? 0,
      attachments: remote.attachments ?? 0,
      attachmentBytes: remote.attachmentBytes ?? 0,
    }
  } catch (error) {
    if (error instanceof ApiError && error.isOffline)
      return local
    throw error
  }
})
export const totpResource = createSettingsResource(() => api.auth.totp.status())

const resources = [backupTargetsResource, backupRunsResource, mcpResource, statsResource, totpResource]
useSession.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || (state.status === 'anonymous' && previous.status !== 'anonymous')) {
    resources.forEach((resource) => resource.clear())
  }
})
