import { normalizeLinkKey, parseFrontMatter } from '@shared/markdown-utils'
import type { ShareEmbed, ShareLink, ShareUnlock } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { extractBlock, extractHeadingSection } from '../../lib/markdown/embeds'
import { parseWikiTarget, renderMarkdown, type WikiTarget } from '../../lib/markdown/renderer'

/** 与预览页一致的展开上限：4 层、单页 24 个嵌入、总字符 200 万。 */
const MAX_DEPTH = 4
const MAX_EMBEDS = 24
const MAX_TOTAL_CHARS = 2_000_000

const FILE_URL_RE = /^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i

interface Scope {
  links: Map<string, ShareLink>
}

type PendingEntry = { depth: number; ancestors: Set<string> }

interface Context {
  slug: string
  rendered: number
  chars: number
  inFlight: Map<string, Promise<ShareEmbed>>
  unlocks: Map<string, string>
  isCurrent?: () => boolean
}

export interface ShareEmbedResolver {
  resolve(root: ParentNode): Promise<void>
  unlock(embed: HTMLElement, password: string): Promise<void>
}

export function createShareEmbedResolver(options: {
  slug: string
  content: string
  links: ShareLink[]
  unlocks?: ShareUnlock[]
  isCurrent?: () => boolean
}): ShareEmbedResolver {
  const ctx: Context = {
    slug: options.slug,
    rendered: 0,
    chars: options.content.length,
    inFlight: new Map(),
    unlocks: new Map((options.unlocks ?? []).map((item) => [item.slug, item.token])),
    isCurrent: options.isCurrent,
  }
  const rootScope: Scope = { links: linkMap(options.links) }
  const pending = new WeakMap<HTMLElement, PendingEntry>()

  return {
    resolve: (root) => walk(root as HTMLElement, ctx, rootScope, 0, new Set(), pending),
    unlock: async (embed, password) => {
      const entry = pending.get(embed)
      if (!entry) return
      const raw = decodeDataValue(embed.dataset.embedTarget)
      const target = parseWikiTarget(raw)
      const key = target.noteTitle ? normalizeLinkKey(target.noteTitle) : ''
      if (!key) return
      await loadInto(embed, key, target, ctx, entry.depth, entry.ancestors, pending, password)
    },
  }
}

async function walk(
  root: HTMLElement,
  ctx: Context,
  scope: Scope,
  depth: number,
  ancestors: Set<string>,
  pending: WeakMap<HTMLElement, PendingEntry>,
): Promise<void> {
  const embeds = [...root.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')]
    .filter((element) => !element.closest('.note-embed-body') || element.closest('.note-embed-body') === root)
  for (const embed of embeds) {
    if (ctx.isCurrent && !ctx.isCurrent()) return
    if (++ctx.rendered > MAX_EMBEDS || depth >= MAX_DEPTH) {
      showError(embed, t('markdown.embed_nesting_limit_reached'))
      continue
    }
    const target = parseWikiTarget(decodeDataValue(embed.dataset.embedTarget))
    const key = target.noteTitle ? normalizeLinkKey(target.noteTitle) : ''
    if (!key || ancestors.has(key)) {
      showError(embed, t('markdown.embed_nesting_limit_reached'))
      continue
    }
    const link = scope.links.get(key)
    if (!link || link.state === 'unavailable') {
      showUnavailable(embed)
      continue
    }
    if (link.state === 'password') {
      pending.set(embed, { depth: depth + 1, ancestors })
      showPasswordPrompt(embed)
      continue
    }
    await loadInto(embed, key, target, ctx, depth + 1, ancestors, pending)
  }
}

async function loadInto(
  embed: HTMLElement,
  key: string,
  target: WikiTarget,
  ctx: Context,
  depth: number,
  ancestors: Set<string>,
  pending: WeakMap<HTMLElement, PendingEntry>,
  password?: string,
): Promise<void> {
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  if (!body) return
  body.setAttribute('aria-busy', 'true')
  body.textContent = t('common.loading')
  try {
    const resolved = await fetchEmbed(ctx, key, password)
    if (ctx.isCurrent && !ctx.isCurrent()) return
    for (const unlock of resolved.unlocks ?? []) ctx.unlocks.set(unlock.slug, unlock.token)
    ctx.chars += resolved.content.length
    if (ctx.chars > MAX_TOTAL_CHARS) {
      showError(embed, t('markdown.embedded_content_is_too_large'))
      return
    }
    const markdown = extractSection(resolved.content, target)
    if (markdown === null) {
      showError(embed, t('markdown.embedded_note_not_found'))
      return
    }
    body.innerHTML = renderMarkdown(markdown).html
    body.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((input) => {
      input.disabled = true
      input.removeAttribute('data-task-line')
      input.setAttribute('aria-label', t('markdown.tasks_in_embedded_notes_are_read_only'))
    })
    applyShareFileAccess(body, ctx.slug, key)
    body.removeAttribute('aria-busy')
    embed.classList.remove('loading', 'error')
    embed.classList.add('ready')
    renderHead(embed, target, resolved.title, resolved.slug)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(key)
    const childScope: Scope = { links: linkMap(resolved.links) }
    await walk(body, ctx, childScope, depth, nextAncestors, pending)
  } catch (error) {
    if (ctx.isCurrent && !ctx.isCurrent()) return
    if (error instanceof ApiError && error.status === 401 && error.code === 'password_invalid') {
      // 口令错误：保留输入框，提示后让访客重试。
      showPasswordPrompt(embed, t('share.incorrect_passcode'))
      return
    }
    if (error instanceof ApiError && error.status === 401) {
      showPasswordPrompt(embed)
      return
    }
    if (error instanceof ApiError && error.status === 413) {
      showError(embed, t('share.embedded_content_too_large'))
      return
    }
    if (error instanceof ApiError && error.status === 404) {
      showUnavailable(embed)
      return
    }
    showError(embed, t('share.embedded_content_unavailable'))
  }
}

function fetchEmbed(ctx: Context, key: string, password?: string): Promise<ShareEmbed> {
  const unlocks = [...ctx.unlocks].map(([slug, token]) => ({ slug, token }))
  if (password) return api.share.embed(ctx.slug, key, password, unlocks)
  const cached = ctx.inFlight.get(key)
  if (cached) return cached
  const request = api.share.embed(ctx.slug, key, undefined, unlocks)
  ctx.inFlight.set(key, request)
  request.catch(() => ctx.inFlight.delete(key))
  return request
}

function extractSection(content: string, target: WikiTarget): string | null {
  const body = parseFrontMatter(content).body
  if (target.blockId) return extractBlock(body, target.blockId)
  if (target.heading) return extractHeadingSection(body, target.heading)
  return body
}

function renderHead(embed: HTMLElement, target: WikiTarget, title: string, slug: string): void {
  const head = embed.querySelector<HTMLElement>('.note-embed-head')
  if (!head) return
  const link = document.createElement('a')
  link.href = `/s/${slug}`
  link.target = '_blank'
  link.rel = 'noopener'
  link.className = head.className
  link.textContent = target.alias || title
  head.replaceWith(link)
}

function showPasswordPrompt(embed: HTMLElement, message?: string): void {
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  if (!body) return
  body.removeAttribute('aria-busy')
  body.replaceChildren()
  const wrap = document.createElement('div')
  wrap.className = 'note-embed-prompt'
  const input = document.createElement('input')
  input.type = 'password'
  input.autocomplete = 'off'
  input.dataset.sharePassword = ''
  input.maxLength = 128
  input.placeholder = t('common.access_passcode')
  input.setAttribute('aria-label', t('common.access_passcode'))
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.shareUnlock = ''
  button.textContent = t('share.unlock_embedded_note')
  wrap.append(input, button)
  body.append(wrap)
  const hint = document.createElement('p')
  hint.className = 'note-embed-hint'
  hint.textContent = message ?? t('share.embedded_note_requires_password')
  body.append(hint)
}

function showUnavailable(embed: HTMLElement): void {
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  if (!body) return
  body.removeAttribute('aria-busy')
  body.textContent = t('share.linked_note_is_not_public')
  embed.classList.remove('loading', 'ready')
  embed.classList.add('error')
}

function showError(embed: HTMLElement, message: string): void {
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  if (!body) return
  body.removeAttribute('aria-busy')
  body.textContent = message
  embed.classList.remove('loading', 'ready')
  embed.classList.add('error')
}

/** 把正文里指向 /api/files 的地址改写成带分享凭证的形式。 */
export function applyShareFileAccess(root: ParentNode, slug: string, key?: string): void {
  for (const element of root.querySelectorAll<HTMLImageElement | HTMLAnchorElement>('img[src], a[href]')) {
    const attr = element instanceof HTMLImageElement ? 'src' : 'href'
    const rewritten = withShareAccess(element.getAttribute(attr), slug, key)
    if (rewritten) element.setAttribute(attr, rewritten)
  }
}

function withShareAccess(raw: string | null, slug: string, key?: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin || !FILE_URL_RE.test(url.pathname)) return null
    url.searchParams.set('share', slug)
    if (key) url.searchParams.set('k', key)
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}

/** 按解析结果改写正文里的 wiki 链接：已公开跳转、加密标记、未公开降级为纯文本。 */
export function applyShareLinks(root: ParentNode, links: ShareLink[]): void {
  const map = linkMap(links)
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a.wikilink[data-wikilink]')) {
    const target = parseWikiTarget(decodeDataValue(anchor.dataset.wikilink))
    const key = target.noteTitle ? normalizeLinkKey(target.noteTitle) : ''
    const link = key ? map.get(key) : undefined
    if (!link || link.state === 'unavailable') {
      anchor.removeAttribute('href')
      anchor.removeAttribute('target')
      anchor.setAttribute('aria-disabled', 'true')
      anchor.classList.add('missing')
      anchor.append(` ${t('share.linked_note_is_not_public')}`)
      continue
    }
    anchor.href = `/s/${link.slug}`
    anchor.target = '_blank'
    anchor.rel = 'noopener'
    if (link.state === 'password') anchor.classList.add('locked')
  }
}

function linkMap(links: ShareLink[]): Map<string, ShareLink> {
  const map = new Map<string, ShareLink>()
  for (const link of links) map.set(link.key, link)
  return map
}
