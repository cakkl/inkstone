import type { ShareLink, ShareLinkState } from '@shared/types'
import { verifyShareAssetSession } from './share-asset-session'

/** 链路最多展开 4 跳，与客户端嵌入层级上限一致。 */
const MAX_CHAIN_DEPTH = 4
/** 链路遍历上限，防止公开分享之间形成大范围图遍历。 */
const MAX_CHAIN_NODES = 200
/** D1 单查询绑定参数上限 99，沿用项目约定的 80。 */
const CHUNK = 80

export interface ShareTarget {
  noteId: string
  userId: string
  shareSlug: string
  passwordHash: string | null
}

interface LinkRow {
  target_key: string
  slug: string | null
  title: string | null
  password_hash: string | null
}

/** 把一篇笔记的链接目标分类：未公开、已过期、已删除一律 unavailable，且不带 slug 与库内标题。 */
export async function resolveShareLinks(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<ShareLink[]> {
  const { results } = await db.prepare(
    `SELECT l.target_key, s.slug, n.title, s.password_hash
       FROM links l
       LEFT JOIN notes n ON n.id = l.target_note_id AND n.deleted_at IS NULL
       LEFT JOIN shares s ON s.note_id = l.target_note_id
                         AND (s.expires_at IS NULL OR s.expires_at > ?2)
      WHERE l.source_note_id = ?1 AND l.user_id = ?3`,
  ).bind(noteId, Date.now(), userId).all<LinkRow>()
  return results.map((row) => {
    if (!row.slug || !row.title) return { key: row.target_key, state: 'unavailable' as const }
    const state: ShareLinkState = row.password_hash ? 'password' : 'shared'
    return { key: row.target_key, state, slug: row.slug, title: row.title }
  })
}

/** 按 slug 取口令会话凭证；没有对应会话时返回 undefined。 */
export type ShareUnlockLookup = (slug: string) => string | undefined

interface ShareNodeRow {
  note_id: string
  user_id: string
  slug: string
  password_hash: string | null
}

interface ChainRow {
  target_key: string
  target_note_id: string
  user_id: string
  node_slug: string
  node_password_hash: string | null
}

/** 从根分享按 key 找链上目标；逐跳校验解锁凭证，未解锁的加密笔记不能当跳板。 */
export async function resolveShareTarget(
  db: D1Database,
  slug: string,
  key: string,
  lookup?: ShareUnlockLookup,
): Promise<ShareTarget | null> {
  const now = Date.now()
  const root = await db.prepare(
    `SELECT s.note_id, s.user_id, s.slug, s.password_hash
       FROM shares s
      WHERE s.slug = ?1 AND (s.expires_at IS NULL OR s.expires_at > ?2)`,
  ).bind(slug, now).first<ShareNodeRow>()
  if (!root) return null
  if (!(await isUnlocked(db, root, lookup))) return null

  const visited = new Set<string>([root.note_id])
  let frontier = [root.note_id]
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length; depth++) {
    const rows: ChainRow[] = []
    for (let index = 0; index < frontier.length; index += CHUNK) {
      const chunk = frontier.slice(index, index + CHUNK)
      const { results } = await db.prepare(
        `SELECT l.target_key, l.target_note_id, s.user_id,
                s.slug AS node_slug, s.password_hash AS node_password_hash
           FROM links l
           JOIN notes n ON n.id = l.target_note_id AND n.deleted_at IS NULL
           JOIN shares s ON s.note_id = l.target_note_id
                        AND (s.expires_at IS NULL OR s.expires_at > ?2)
          WHERE l.source_note_id IN (${chunk.map((_, i) => `?${i + 3}`).join(', ')})
            AND l.user_id = ?1`,
      ).bind(root.user_id, now, ...chunk).all<ChainRow>()
      rows.push(...results)
    }
    for (const row of rows) {
      if (row.target_key === key) {
        return {
          noteId: row.target_note_id,
          userId: row.user_id,
          shareSlug: row.node_slug,
          passwordHash: row.node_password_hash,
        }
      }
    }
    const next: string[] = []
    for (const row of rows) {
      if (visited.has(row.target_note_id) || visited.size >= MAX_CHAIN_NODES) continue
      // 未解锁的加密笔记不展开：它下面的一切都视为不可达。
      if (!(await isUnlocked(db, { slug: row.node_slug, password_hash: row.node_password_hash }, lookup))) continue
      visited.add(row.target_note_id)
      next.push(row.target_note_id)
    }
    frontier = next
  }
  return null
}

async function isUnlocked(
  db: D1Database,
  node: { slug: string; password_hash: string | null },
  lookup?: ShareUnlockLookup,
): Promise<boolean> {
  if (!node.password_hash) return true
  const token = lookup?.(node.slug)
  if (!token) return false
  return verifyShareAssetSession(db, token, node.slug, node.password_hash)
}
