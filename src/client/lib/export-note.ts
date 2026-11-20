import { renderMarkdown } from './markdown/renderer'
import { decodeDataValue } from './markdown/data-attr'
import { api } from './api'
import { extractAttachmentIds } from '@shared/markdown-utils'
import { createZip } from '@shared/zip'
import { useUi } from '../store/ui'
import { t } from './i18n'

// 尖括号是原笔记里的写法，导出路径已百分号编码，不需要包裹。
const ATTACHMENT_LINK_RE =
  /<((?:https?:\/\/[^/\s<>"']+)?\/api\/files\/([0-9a-hjkmnp-tv-z]{26}))>|((?:https?:\/\/[^/\s<>"']+)?\/api\/files\/([0-9a-hjkmnp-tv-z]{26}))(?=$|[\s>)\]"'?#])/g
const EXPORT_PENDING_DELAY_MS = 120
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
  const body = note.content.replace(ATTACHMENT_LINK_RE, (match, _wrapped: string, wrappedId: string, _bare: string, bareId: string) => {
    const id = wrappedId ?? bareId;
    return links.get(id) ?? match;
  })
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

export type NoteExportFormat = 'md' | 'html' | 'pdf'

let exportInFlight = false

/** 统一的导出入口：去重、进行中提示与失败提示都在这里，调用方只需传入格式。 */
export async function exportNote(
  format: NoteExportFormat,
  note: { title: string; content: string },
  locale: string,
): Promise<void> {
  if (exportInFlight) return
  exportInFlight = true
  const toast = useUi.getState().toast
  const dismissToast = useUi.getState().dismissToast
  let pendingToastId = ''
  const pendingTimer = window.setTimeout(() => {
    pendingToastId = toast({ title: t('workspace.export_preparing'), duration: 0 })
  }, EXPORT_PENDING_DELAY_MS)
  try {
    if (format === 'html') {
      await exportNoteAsHtml(note, locale)
    }
    else if (format === 'pdf') {
      await exportNoteAsPdf(note, locale)
    }
    else {
      const images = await exportNoteAsMarkdown(note)
      if (images)
        toast({ title: t('workspace.export_markdown_bundle', { value0: images }) })
    }
  }
  catch (err) {
    toast({
      title: t('workspace.export_failed'),
      description: err instanceof Error ? err.message : String(err),
      tone: 'danger',
    })
  }
  finally {
    window.clearTimeout(pendingTimer)
    if (pendingToastId) dismissToast(pendingToastId)
    exportInFlight = false
  }
}

export async function exportNoteAsHtml(note: { title: string; content: string }, language: string): Promise<void> {
  const [body, css] = await Promise.all([exportBody(note.content), localKatexCss()])
  downloadTextFile(`${safeFileName(note.title) || 'note'}.html`, htmlDocument(note.title, body, language, css), 'text/html;charset=utf-8')
}

export async function exportNoteAsPdf(note: { title: string; content: string }, language: string): Promise<void> {
  const [body, css] = await Promise.all([exportBody(note.content), localKatexCss()])
  const html = htmlDocument(note.title, body, language, css)
  await printHtml(html)
}

async function exportBody(content: string): Promise<string> {
  const rendered = renderMarkdown(content)
  const inlined = await inlinePrivateImages(rendered.html)
  return prepareExportDom(inlined)
}

/** 导出的 HTML 里没有脚本，靠 enhance.ts 填充的元素会停在占位态，这里换成静态内容。 */
async function prepareExportDom(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  flattenTabs(doc)
  unlinkReferences(doc)
  replaceEmbeds(doc)
  downgradeMermaid(doc)
  for (const button of [...doc.querySelectorAll('[data-copy]')]) button.remove()
  await renderMath(doc)
  return doc.body.innerHTML
}

function flattenTabs(doc: Document): void {
  for (const tabs of [...doc.querySelectorAll<HTMLElement>('.markdown-tabs')]) {
    const titles = [...tabs.querySelectorAll<HTMLElement>('[data-tab-button]')].map((button) => button.textContent ?? '')
    tabs.querySelector('.tab-list')?.remove()
    for (const panel of [...tabs.querySelectorAll<HTMLElement>('[data-tab-panel]')]) {
      panel.removeAttribute('hidden')
      panel.removeAttribute('id')
      panel.removeAttribute('role')
      panel.removeAttribute('aria-labelledby')
      const title = titles[Number(panel.dataset.tabPanel)]
      if (title) {
        const label = doc.createElement('p')
        label.className = 'export-panel-title'
        label.textContent = title
        panel.before(label)
      }
    }
  }
}

function unlinkReferences(doc: Document): void {
  for (const anchor of [...doc.querySelectorAll<HTMLAnchorElement>('a.wikilink, a.block-reference')]) {
    const span = doc.createElement('span')
    span.className = anchor.className
    span.textContent = anchor.textContent
    anchor.replaceWith(span)
  }
}

function replaceEmbeds(doc: Document): void {
  for (const embed of [...doc.querySelectorAll<HTMLElement>('.note-embed')]) {
    const target = decodeDataValue(embed.dataset.embedTarget)
    const note = doc.createElement('p')
    note.className = 'export-note-embed'
    note.textContent = t('workspace.export_embed_note', { value0: target })
    const wrapper = embed.closest('.note-embed-paragraph')
    if (wrapper) wrapper.replaceWith(note)
    else embed.replaceWith(note)
  }
}

function downgradeMermaid(doc: Document): void {
  for (const block of [...doc.querySelectorAll<HTMLElement>('.mermaid-block')]) {
    const source = decodeDataValue(block.dataset.mermaid)
    const pre = doc.createElement('pre')
    pre.className = 'export-source'
    const code = doc.createElement('code')
    code.textContent = source
    pre.append(code)
    block.replaceWith(pre)
  }
}

async function renderMath(doc: Document): Promise<void> {
  const nodes = [...doc.querySelectorAll<HTMLElement>('[data-math]')]
  if (!nodes.length) return
  let katex: { renderToString: (source: string, options: Record<string, unknown>) => string } | null = null
  try {
    katex = (await import('./katex-loader')).default
  }
  catch {
    katex = null
  }
  for (const node of nodes) {
    const source = decodeDataValue(node.dataset.math)
    const display = node.classList.contains('math-block')
    delete node.dataset.math
    if (!katex) {
      showMathSource(node, source, display)
      continue
    }
    try {
      node.innerHTML = katex.renderToString(source, { displayMode: display, throwOnError: false })
    }
    catch {
      showMathSource(node, source, display)
    }
  }
}

function showMathSource(node: HTMLElement, source: string, display: boolean): void {
  node.classList.add('math-source')
  node.textContent = display ? `$$\n${source}\n$$` : `$${source}$`
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
.wikilink, .block-reference { color: #4b5563; text-decoration: none; border-bottom: 1px dashed #9ca3af; }
.math-source { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; color: #4b5563; background: #f3f4f6; border-radius: 4px; padding: 0.15em 0.4em; }
div.math-source { display: block; white-space: pre-wrap; padding: 0.8em 1em; margin: 0.9em 0; }
.export-source { background: #f3f4f6; color: #1f2328; border-radius: 8px; padding: 0.9em 1.1em; margin: 0.9em 0; overflow-x: auto; }
.export-source code { background: transparent; padding: 0; font-size: 0.88em; }
.export-note-embed { margin: 0.9em 0; padding: 0.5em 0.9em; border-left: 3px dashed #9ca3af; color: #4b5563; font-size: 0.95em; }
.export-panel-title { margin: 1em 0 0.3em; font-size: 0.95em; font-weight: 600; color: #374151; }
.math-block { display: block; margin: 0.9em 0; text-align: center; }
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
