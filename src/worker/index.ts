import { runAttachmentCleanup } from './attachments/cleanup'
import { runScheduledBackups } from './backup/scheduler'
import type { Env } from './env'
import { initializeDatabase } from './db/schema'
import { drainAllFtsQueues } from './db/fts'
import { runScheduledTasks } from './lib/scheduled-tasks'
import { AI_INDEX_DRAIN_BUDGET, drainAiIndexQueue } from './mcp/ai-search'
import { drainSummaryQueue } from './summary/queue'
import { drainPendingPurges } from './summary/drain-purge'
import { createOAuthProvider, purgeExpiredOAuthData } from './mcp/oauth'
import { purgeRevokedMcpApiKeys } from './mcp/api-keys'
import { purgeExpiredMcpOperations } from './mcp/operations'
import { purgeExpiredOperationalData } from './lib/maintenance'
import { ApiError } from './lib/errors'
import { normalizeRepeatedOAuthResource } from './lib/oauth-request'

export { SyncHub } from './realtime/sync-hub'
export { CredentialVault } from './durable/credential-vault'

// Codex CLI drops the `iss` callback parameter while its rmcp
// dependency enforces it whenever the authorization server advertises
// `authorization_response_iss_parameter_supported` (openai/codex#31573), so
// login fails even though the parameter is on the wire. Serve the metadata
// without that flag to keep codex compatible; the standard RFC 9207 `iss`
// parameter is still appended to callbacks for conforming clients.
const OAUTH_AUTHORIZATION_SERVER_METADATA = '/.well-known/oauth-authorization-server'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let oauthRequest: Request
    try {
      oauthRequest = await normalizeRepeatedOAuthResource(request)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      return Response.json(
        { error: 'invalid_request', error_description: error.message },
        { status: error.status },
      )
    }
    const provider = createOAuthProvider(oauthRequest, env)
    if (new URL(oauthRequest.url).pathname === OAUTH_AUTHORIZATION_SERVER_METADATA) {
      return oauthMetadataWithoutIssParameter(provider, oauthRequest, env, ctx)
    }
    return provider.fetch(oauthRequest, env, ctx)
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        await initializeDatabase(env)
      } catch (error) {
        console.error('[inkstone] Scheduled run skipped: database initialization failed', error)
        return
      }

      // 轻维护：每个任务只有一两次查询，并发也不会把 D1 压垮。
      await runScheduledTasks('maintenance', [
        ['attachments', () => runAttachmentCleanup(env)],
        ['mcp-operations', () => purgeExpiredMcpOperations(env.DB)],
        ['operational-data', () => purgeExpiredOperationalData(env.DB)],
        ['mcp-api-keys', () => purgeRevokedMcpApiKeys(env.DB)],
        ['oauth', () => purgeExpiredOAuthData(env)],
        ['summary-purge', () => drainPendingPurges(env)],
        ['fts-index', () => drainAllFtsQueues(env.DB)],
      ], 3)

      // 重活：会连续发大量读写（备份快照、逐篇 embedding、逐篇摘要），
      // 与上面的轻维护分开跑，避免所有任务的第一批查询同时压到 D1。
      await runScheduledTasks('batch', [
        ['backup', () => runScheduledBackups(env)],
        ['ai-index', () => drainAiIndexQueue(env, AI_INDEX_DRAIN_BUDGET)],
        // 每小时最多 25 篇；额度耗尽会在内部 break，不会烧超。
        ['summary-queue', () => drainSummaryQueue(env, 25)],
      ], 2)
    })())
  },
} satisfies ExportedHandler<Env>

async function oauthMetadataWithoutIssParameter(
  provider: ReturnType<typeof createOAuthProvider>,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await provider.fetch(request, env, ctx)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.ok || !contentType.includes('application/json')) return response
  const metadata = (await response.json()) as Record<string, unknown>
  delete metadata.authorization_response_iss_parameter_supported
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
