import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderer'

// 覆盖项目自研的全部扩展语法。markdown-it 15 是 major 升级，
// 这里锁住输出，防止 ruler / renderer.rules 行为被静默改变。
const samples: Record<string, string> = {
  heading: '# 一级标题\n\n正文段落。',
  table: '| a | b |\n| - | - |\n| 1 | 2 |',
  image: '![替代文字](/img.png "图片标题")',
  link: '[外链](https://example.com) 和 [内链](/note)',
  code: '```js\nconst a = 1\n```',
  inlineCode: '行内 `code` 片段',
  taskList: '- [ ] 待办\n- [x] 已完成',
  footnote: '正文[^1]\n\n[^1]: 脚注内容',
  mark: '==高亮文字==',
  mathInline: '行内公式 $a^2+b^2=c^2$',
  mathBlock: '$$\na^2+b^2=c^2\n$$',
  wikilink: '[[目标笔记]] 与 [[目标笔记|显示名]]',
  frontMatter: '---\ntitle: 测试\n---\n\n正文',
  details: ':::details 展开\n内容\n:::',
  tabs: ':::tabs\n:::tab 一\nA\n:::\n:::tab 二\nB\n:::\n:::',
  blockReference: '引用 ^block-id',
}

describe('markdown 渲染快照（markdown-it 15 升级回归）', () => {
  for (const [name, source] of Object.entries(samples)) {
    it(`${name} 输出稳定`, () => {
      const result = renderMarkdown(source)
      // nonce 与 uuid 每次渲染都不同，归一化后才能跨版本对比。
      const stable = result.html
        .replace(/ink-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ink-NONCE')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
      expect(stable).toMatchSnapshot()
    })
  }
})
