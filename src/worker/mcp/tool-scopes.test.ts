import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { createInkstoneMcpServer, type McpAuthProps } from './server'
import { MCP_SCOPES } from './settings'

/** 注册阶段不触碰 env 与 executionCtx，占位对象即可。 */
const env = {} as Env
const executionCtx = {} as ExecutionContext

function toolNames(scopes: string[]): string[] {
  const auth: McpAuthProps = { userId: 'test-user', role: 'owner', scopes }
  const server = createInkstoneMcpServer({
    env,
    auth,
    origin: 'https://example.com',
    ftsEnabled: false,
    executionCtx,
  })
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  return Object.keys(registered).sort()
}

describe('按 scope 条件注册工具', () => {
  it('只读连接不注册写入与回收站工具', () => {
    const names = toolNames([MCP_SCOPES.read])
    expect(names).toHaveLength(19)
    expect(names).toContain('read_note')
    expect(names).toContain('search')
    expect(names).not.toContain('edit_note')
    expect(names).not.toContain('trash_note')
  })

  it('写入 scope 解锁写入工具但不含回收站', () => {
    const names = toolNames([MCP_SCOPES.read, MCP_SCOPES.write])
    expect(names).toHaveLength(38)
    expect(names).toContain('edit_note')
    expect(names).toContain('create_note')
    expect(names).not.toContain('trash_note')
  })

  it('回收站 scope 解锁 trash_note', () => {
    const names = toolNames([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash])
    expect(names).toHaveLength(39)
    expect(names).toContain('trash_note')
  })
})
