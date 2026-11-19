import { afterEach, describe, expect, it, vi } from 'vitest'
import { readZip } from '@shared/zip'
import { exportNoteAsMarkdown } from './export-note'

const IMAGE_ID = '01m1r8923zajxnw9y0dhs6sy8j'

function captureDownload(): { blobs: Blob[]; restore: () => void } {
  const blobs: Blob[] = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return 'blob:inkstone'
  })
  URL.revokeObjectURL = vi.fn()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return {
    blobs,
    restore: () => {
      click.mockRestore()
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      vi.unstubAllGlobals()
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('exportNoteAsMarkdown', () => {
  it('downloads a plain .md when the note has no attachments', async () => {
    const { blobs, restore } = captureDownload()
    const count = await exportNoteAsMarkdown({ title: 'Plain', content: 'hello' })
    restore()
    expect(count).toBe(0)
    expect(blobs).toHaveLength(1)
    expect(await blobs[0]!.text()).toContain('hello')
  })

  it('bundles referenced images and rewrites links to relative paths', async () => {
    const { blobs, restore } = captureDownload()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/files') {
        return new Response(JSON.stringify({ files: [{ id: IMAGE_ID, filename: '图 1.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } })
    }))
    const content = `before\n\n![shot](/api/files/${IMAGE_ID})\n\nafter`
    const count = await exportNoteAsMarkdown({ title: 'Trip plan', content })
    restore()

    expect(count).toBe(1)
    const entries = await readZip(new Uint8Array(await blobs[0]!.arrayBuffer()))
    const paths = entries.map((entry) => entry.path)
    expect(paths).toContain('Trip plan.md')
    expect(paths).toContain('Trip plan.assets/图 1.png')
    const markdown = new TextDecoder().decode(entries.find((entry) => entry.path === 'Trip plan.md')!.data)
    expect(markdown).toContain('![shot](./Trip%20plan.assets/图%201.png)')
    expect(markdown).not.toContain('/api/files/')
  })

  it('rewrites absolute-host attachment links the same way', async () => {
    const { blobs, restore } = captureDownload()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/files')
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } })
    }))
    const count = await exportNoteAsMarkdown({
      title: 'Trip',
      content: `![a](https://notes.example.com/api/files/${IMAGE_ID})`,
    })
    restore()

    expect(count).toBe(1)
    const entries = await readZip(new Uint8Array(await blobs[0]!.arrayBuffer()))
    const markdown = new TextDecoder().decode(entries.find((entry) => entry.path === 'Trip.md')!.data)
    expect(markdown).toContain(`![a](./Trip.assets/${IMAGE_ID}.webp)`)
  })

  it('falls back to a plain .md when the attachment cannot be fetched', async () => {
    const { blobs, restore } = captureDownload()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const count = await exportNoteAsMarkdown({ title: 'Trip', content: `![shot](/api/files/${IMAGE_ID})` })
    restore()
    expect(count).toBe(0)
    expect(await blobs[0]!.text()).toContain(`/api/files/${IMAGE_ID}`)
  })
})
