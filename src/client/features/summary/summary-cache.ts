import type { AiNoteSummaryResponse } from '@shared/types'

const STORAGE_KEY = 'inkstone:summary-cache:v1'

/** First-paint reuse window; older entries still render as placeholders while refreshing. */
export const SUMMARY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200

interface CacheEntry {
  savedAt: number
  state: AiNoteSummaryResponse
}

/** userId -> noteId -> entry: switching accounts must never surface another user's summary. */
type Bucket = Record<string, CacheEntry>

let memory: Bucket | null = null

function load(): Bucket {
  if (memory) return memory
  memory = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return memory
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return memory
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<CacheEntry> | null
      if (!entry || typeof entry !== 'object' || !entry.state || typeof entry.savedAt !== 'number') continue
      memory[key] = { savedAt: entry.savedAt, state: entry.state }
    }
  } catch {
    // Private mode or corrupt data: behave as if nothing was cached.
  }
  return memory
}

function persist(bucket: Bucket): void {
  try {
    const entries = Object.entries(bucket)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].savedAt - a[1].savedAt)
      bucket = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
      memory = bucket
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bucket))
  } catch {
    // Failing to persist only costs a slower first paint.
  }
}

function key(userId: string, noteId: string): string {
  return `${userId}:${noteId}`
}

/** 读首屏快照；属于别的登录态时返回 null。`allowStale` 时忽略时限，用于先占位再刷新。 */
export function readCachedSummary(
  userId: string | null | undefined,
  noteId: string,
  options: { allowStale?: boolean; now?: number } = {},
): AiNoteSummaryResponse | null {
  if (!userId) return null
  const entry = load()[key(userId, noteId)]
  if (!entry) return null
  const now = options.now ?? Date.now()
  // 过期条目保留在库里：调用方可能仍想用它占位，只是不再当作「现状」。
  if (!options.allowStale && now - entry.savedAt > SUMMARY_CACHE_MAX_AGE_MS) return null
  return entry.state
}

export function writeCachedSummary(
  userId: string | null | undefined,
  noteId: string,
  state: AiNoteSummaryResponse,
): void {
  if (!userId) return
  const bucket = load()
  bucket[key(userId, noteId)] = { savedAt: Date.now(), state }
  persist(bucket)
}

/** Drop one note's snapshot, e.g. after the summary was disabled or deleted. */
export function dropCachedSummary(userId: string | null | undefined, noteId: string): void {
  if (!userId) return
  const bucket = load()
  if (!(key(userId, noteId) in bucket)) return
  delete bucket[key(userId, noteId)]
  persist(bucket)
}

/** Logout or account switch: clear everything so summaries never linger. */
export function clearSummaryCache(): void {
  memory = {}
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do: it is only a cache.
  }
}
