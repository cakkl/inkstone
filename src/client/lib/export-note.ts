import { renderMarkdown } from './markdown/renderer'
import { api } from './api'
import { extractAttachmentIds } from '@shared/markdown-utils'
import { createZip } from '@shared/zip'

const ATTACHMENT_LINK_RE =
  /(?:https?:\/\/[^/\s<>"']+)?\/api\/files\/([0-9a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g
const UTF8_ENCODER = new TextEncoder()
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/apng': '.apng',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
}

/** 内联本地 KaTeX CSS：避免 CDN 依赖与版本硬编码漂移（约 24 KB，仅导出时加载）。 */
async function localKatexCss(): Promise<string> {
  try {
    const mod = await import('katex/dist/katex.min.css?inline')
    return mod.default
  } catch {
    return ''
  }
}

export function downloadTextFile(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function frontMatter(title: string): string {
  const value = title.trim()
  return value ? `---\ntitle: ${JSON.stringify(value)}\n---\n\n` : ''
}

function markdownDocument(note: { title: string; content: string }): string {
  return `${frontMatter(note.title)}${note.content}`
}

export async function exportNoteAsMarkdown(note: { title: string; content: string }): Promise<number> {
  const name = safeFileName(note.title.trim()) || 'note'
  const entries = await collectAttachments(note.content)
  if (!entries.length) {
    downloadTextFile(`${name}.md`, markdownDocument(note), 'text/markdown; charset=utf-8')
    return 0
  }
  const directory = `${name}.assets`
  const linkDirectory = `./${encodeAssetName(directory)}`
  const links = new Map(entries.map((entry) => [entry.id, `${linkDirectory}/${encodeAssetName(entry.filename)}`]))
  const body = note.content.replace(ATTACHMENT_LINK_RE, (match, id: string) => links.get(id) ?? match)
  const archive = createZip([
    { path: `${name}.md`, data: UTF8_ENCODER.encode(`${frontMatter(note.title)}${body}`) },
    ...entries.map((entry) => ({ path: `${directory}/${entry.filename}`, data: entry.data })),
  ])
  downloadBlob(`${name}.zip`, new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' }))
  return entries.length
}

interface ExportedAttachment {
  id: string
  filename: string
  data: Uint8Array
}

async function collectAttachments(content: string): Promise<ExportedAttachment[]> {
  const ids = extractAttachmentIds(content)
  if (!ids.length)
    return []
  const names = await attachmentFilenames()
  const used = new Set<string>()
  const collected: ExportedAttachment[] = []
  for (const id of ids) {
    try {
      const response = await fetch(`/api/files/${id}`, { credentials: 'same-origin' })
      if (!response.ok)
        continue
      const blob = await response.blob()
      const filename = uniqueAssetName(names.get(id) ?? `${id}${IMAGE_EXTENSIONS[blob.type] ?? ''}`, used)
      collected.push({ id, filename, data: new Uint8Array(await blob.arrayBuffer()) })
    }
    catch {
    }
  }
  return collected
}

async function attachmentFilenames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  let cursor: string | undefined
  try {
    do {
      const page = await api.files.list(cursor)
      for (const file of page.files)
        names.set(file.id, file.filename)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  catch {
  }
  return names
}

function uniqueAssetName(name: string, used: Set<string>): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file'
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const extension = dot > 0 ? cleaned.slice(dot) : ''
  let candidate = cleaned
  let index = 2
  while (used.has(candidate.toLowerCase()))
    candidate = `${stem}-${index++}${extension}`
  used.add(candidate.toLowerCase())
  return candidate
}

function encodeAssetName(name: string): string {
  return name.replace(/[\s()<>#?%[\]]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

export async function exportNoteAsHtml(note: { title: string; content: string }, language: string): Promise<void> {
  const rendered = renderMarkdown(note.content)
  const [body, css] = await Promise.all([inlinePrivateImages(rendered.html), localKatexCss()])
  downloadTextFile(`${safeFileName(note.title) || 'note'}.html`, htmlDocument(note.title, body, language, css), 'text/html;charset=utf-8')
}

export async function exportNoteAsPdf(note: { title: string; content: string }, language: string): Promise<void> {
  const rendered = renderMarkdown(note.content)
  const [body, css] = await Promise.all([inlinePrivateImages(rendered.html), localKatexCss()])
  const html = htmlDocument(note.title, body, language, css)
  await printHtml(html)
}

async function printHtml(html: string): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  try {
    const win = iframe.contentWindow
    if (!win) return
    iframe.srcdoc = html
    await waitForPrintReady(iframe)
    win.focus()
    win.print()
  } finally {
    setTimeout(() => iframe.remove(), 1000)
  }
}

async function waitForPrintReady(iframe: HTMLIFrameElement): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    iframe.addEventListener('load', finish)
    setTimeout(finish, 2000)
  })
}

async function inlinePrivateImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const images = [...doc.querySelectorAll<HTMLImageElement>('img')]
    .filter((image) => /(?:^|[/:])api\/files\//.test(image.getAttribute('src') ?? ''))
  await Promise.all(images.map(async (image) => {
    try {
      const response = await fetch(image.getAttribute('src')!, { credentials: 'same-origin' })
      if (!response.ok)
        return
      const dataUrl = await blobToDataUrl(await response.blob())
      if (dataUrl)
        image.setAttribute('src', dataUrl)
    }
    catch {
    }
  }))
  return doc.body.innerHTML
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

function safeFileName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function htmlDocument(title: string, bodyHtml: string, language: string, katexCss: string): string {
  const safeTitle = escapeHtml(title)
  return `<!DOCTYPE html>
<html lang="${escapeAttr(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
${katexCss ? `<style>${katexCss}</style>` : ''}
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.75rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.75; color: #1f2328; background: #fff; }
@media print { body { padding: 0; max-width: none; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.6em; }
h1 { font-size: 1.75em; }
h2 { font-size: 1.4em; padding-bottom: 0.25em; border-bottom: 1px solid #e5e7eb; }
h3 { font-size: 1.18em; }
h4 { font-size: 1.05em; }
p { margin: 0.7em 0; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
a.wikilink { color: #4b5563; text-decoration: none; border-bottom: 1px dashed #9ca3af; }
strong { font-weight: 600; }
del { color: #6b7280; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.88em; background: #f3f4f6; border-radius: 4px; padding: 0.15em 0.35em; }
pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 1em 1.1em; overflow-x: auto; line-height: 1.6; margin: 0.9em 0; }
pre code { background: transparent; padding: 0; font-size: 0.85em; color: inherit; }
blockquote { margin: 0.9em 0; padding: 0.2em 1.1em; border-left: 3px solid #d1d5db; color: #4b5563; }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.6em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.9em 0; font-size: 0.95em; }
th, td { border: 1px solid #d1d5db; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.25em 0; }
li.task-list-item { list-style: none; }
input.task-list-item-checkbox { margin-right: 0.45em; transform: translateY(1px); }
details { margin: 0.9em 0; padding: 0.7em 1em; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; }
summary { cursor: pointer; font-weight: 600; }
details[open] summary { margin-bottom: 0.4em; }
.callout { border-left: 4px solid #6b7280; border-radius: 6px; padding: 0.65em 1em; margin: 0.9em 0; background: #f9fafb; }
.callout[data-callout="warning"] { border-color: #d97706; }
.callout[data-callout="danger"], .callout[data-callout="error"] { border-color: #dc2626; }
.callout[data-callout="success"], .callout[data-callout="tip"] { border-color: #16a34a; }
.callout[data-callout="info"], .callout[data-callout="note"] { border-color: #2563eb; }
.callout-title { font-weight: 600; margin-bottom: 0.25em; }
.callout-content > :first-child { margin-top: 0; }
.callout-content > :last-child { margin-bottom: 0; }
.footnote-ref { font-size: 0.8em; }
.footnotes { font-size: 0.9em; color: #4b5563; border-top: 1px solid #e5e7eb; margin-top: 1.5em; padding-top: 0.75em; }
kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 4px; padding: 0.08em 0.35em; font-family: ui-monospace, monospace; font-size: 0.85em; }
sub, sup { line-height: 0; }
</style>
</head>
<body>
${safeTitle ? `<h1>${safeTitle}</h1>` : ''}
${bodyHtml}
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character] ?? character
  })
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;')
}
