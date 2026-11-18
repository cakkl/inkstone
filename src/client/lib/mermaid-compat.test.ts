import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'

describe('mermaid 12 运行时兼容性', () => {
  it('initialize 接受现有配置', () => {
    expect(() =>
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        suppressErrorRendering: true,
        themeVariables: { fontSize: '13px', background: 'transparent' },
      }),
    ).not.toThrow()
  })

  it('parse 接受有效语法、拒绝无效语法', async () => {
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' })
    await expect(mermaid.parse('graph TD; A-->B;')).resolves.toBeTruthy()
    await expect(mermaid.parse('graph TD; A-->')).rejects.toThrow()
  })
})
