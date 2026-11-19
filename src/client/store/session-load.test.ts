import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicUser, SessionInfo } from '@shared/types'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  loadSession: vi.fn(),
  clearSession: vi.fn(async () => {}),
  saveSession: vi.fn(async () => {}),
  bindLocalUser: vi.fn(async () => {}),
}))

vi.mock('../lib/db', () => ({
  localDb: {
    loadSession: mocks.loadSession,
    clearSession: mocks.clearSession,
    saveSession: mocks.saveSession,
    bindLocalUser: mocks.bindLocalUser,
  },
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<any>('../lib/api')
  return { ...actual, api: { ...actual.api, session: mocks.session } }
})
import { initI18n } from '../lib/i18n'
import { ApiError } from '../lib/api'
import { useSession } from './session'

const user: PublicUser = {
  id: 'user-1', login: 'admin', username: 'admin', name: 'Admin', role: 'owner',
  avatarUrl: '', createdAt: 1,
}
const site = { version: '0.8.0', registrationOpen: false } as SessionInfo['site']
const cachedInfo: SessionInfo = { user, site, settings: null } as unknown as SessionInfo
const remoteInfo: SessionInfo = { user: { ...user, name: 'Renamed' }, site, settings: null } as unknown as SessionInfo

beforeEach(async () => {
  await initI18n()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  mocks.session.mockReset()
  mocks.loadSession.mockReset()
  mocks.saveSession.mockClear()
  useSession.setState({ status: 'loading', user: null, site: null, authError: null })
})
afterEach(() => vi.unstubAllGlobals())

describe('session load', () => {
  it('renders the cached session before the server answers', async () => {
    mocks.loadSession.mockResolvedValue(cachedInfo)
    let resolveRemote!: (value: SessionInfo) => void
    mocks.session.mockImplementation(() => new Promise<SessionInfo>((done) => { resolveRemote = done }))

    const loading = useSession.getState().load()
    await vi.waitFor(() => expect(useSession.getState().status).toBe('authed'))
    expect(useSession.getState().user?.name).toBe('Admin')

    resolveRemote(remoteInfo)
    await loading
    expect(useSession.getState().user?.name).toBe('Renamed')
  })

  it('keeps the cached session when the server is unreachable', async () => {
    mocks.loadSession.mockResolvedValue(cachedInfo)
    mocks.session.mockRejectedValue(new ApiError(0, 'offline', 'no network'))
    await useSession.getState().load()
    expect(useSession.getState().status).toBe('authed')
    expect(useSession.getState().user?.name).toBe('Admin')
    expect(useSession.getState().authError).toBeNull()
  })

  it('falls back to the login screen when there is no cache and the server fails', async () => {
    mocks.loadSession.mockResolvedValue(null)
    mocks.session.mockRejectedValue(new ApiError(0, 'offline', 'no network'))
    await useSession.getState().load()
    expect(useSession.getState().status).toBe('anonymous')
    expect(useSession.getState().authError).toBeTruthy()
  })

  it('drops the cached session when the server reports nobody signed in', async () => {
    mocks.loadSession.mockResolvedValue(cachedInfo)
    mocks.session.mockResolvedValue({ user: null, site, settings: null } as unknown as SessionInfo)
    await useSession.getState().load()
    expect(useSession.getState().status).toBe('anonymous')
    expect(useSession.getState().user).toBeNull()
  })

  it('shares one request between concurrent calls', async () => {
    mocks.loadSession.mockResolvedValue(null)
    mocks.session.mockResolvedValue(remoteInfo)
    await Promise.all([useSession.getState().load(), useSession.getState().load()])
    expect(mocks.session).toHaveBeenCalledTimes(1)
  })
})
