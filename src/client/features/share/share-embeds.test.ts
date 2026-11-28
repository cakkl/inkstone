import { describe, expect, it } from 'vitest'
import { normalizeLinkKey } from '@shared/markdown-utils'
import type { ShareLink } from '@shared/types'
import { encodeDataValue } from '../../lib/markdown/data-attr'
import { applyShareFileAccess, applyShareLinks } from './share-embeds'

const NOTE_KEY = normalizeLinkKey('目标笔记')
// 附件 URL 只接受 26 位 ULID 形态的 id。
const FILE_ID = `01j${'0'.repeat(23)}`

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function wikiAnchor(): string {
  return `<a class="wikilink" data-wikilink="${encodeDataValue('目标笔记')}" href="#">目标笔记</a>`
}

function linkOf(state: ShareLink['state']): ShareLink {
  return state === 'unavailable'
    ? { key: NOTE_KEY, state }
    : { key: NOTE_KEY, state, slug: 'abcdefgh', title: '目标笔记' }
}

describe('applyShareLinks', () => {
  it('已公开的目标改写为真实链接并在新标签页打开', () => {
    const root = mount(wikiAnchor())
    applyShareLinks(root, [linkOf('shared')])
    const anchor = root.querySelector('a.wikilink')!
    expect(anchor.getAttribute('href')).toBe('/s/abcdefgh')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener')
  })

  it('加密的目标保留链接并标记 locked', () => {
    const root = mount(wikiAnchor())
    applyShareLinks(root, [linkOf('password')])
    const anchor = root.querySelector('a.wikilink')!
    expect(anchor.getAttribute('href')).toBe('/s/abcdefgh')
    expect(anchor.classList.contains('locked')).toBe(true)
  })

  it('未公开的目标降级为不可用文本', () => {
    const root = mount(wikiAnchor())
    applyShareLinks(root, [linkOf('unavailable')])
    const anchor = root.querySelector('a.wikilink')!
    expect(anchor.hasAttribute('href')).toBe(false)
    expect(anchor.getAttribute('aria-disabled')).toBe('true')
    expect(anchor.classList.contains('missing')).toBe(true)
    expect(anchor.textContent!.length).toBeGreaterThan('目标笔记'.length)
  })

  it('没有解析结果的目标按未公开处理', () => {
    const root = mount(wikiAnchor())
    applyShareLinks(root, [])
    expect(root.querySelector('a.wikilink')!.hasAttribute('href')).toBe(false)
  })
})

describe('applyShareFileAccess', () => {
  it('分享笔记自身的附件只带 share 参数', () => {
    const root = mount(`<img src="/api/files/${FILE_ID}">`)
    applyShareFileAccess(root, 'abcdefgh')
    const src = root.querySelector('img')!.getAttribute('src')!
    expect(src).toContain(`/api/files/${FILE_ID}`)
    expect(src).toContain('share=abcdefgh')
    expect(src).not.toContain('k=')
  })

  it('嵌入笔记的附件额外带 k 参数以便链式授权', () => {
    const root = mount(`<img src="/api/files/${FILE_ID}">`)
    applyShareFileAccess(root, 'abcdefgh', NOTE_KEY)
    const src = root.querySelector('img')!.getAttribute('src')!
    expect(src).toContain(`k=${encodeURIComponent(NOTE_KEY)}`)
  })

  it('外部地址与非附件路径保持原样', () => {
    const root = mount(`<a href="https://example.com/s/abcdefgh">x</a><img src="/logo.svg">`)
    applyShareFileAccess(root, 'abcdefgh')
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://example.com/s/abcdefgh')
    expect(root.querySelector('img')!.getAttribute('src')).toBe('/logo.svg')
  })
})
