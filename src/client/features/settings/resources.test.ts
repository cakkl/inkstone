import { afterEach, describe, expect, it } from 'vitest'
import { useSession } from '../../store/session'
import { localDataOverview, statsResource, totpResource } from './resources'

const initial = useSession.getState()
afterEach(() => useSession.setState(initial))

function overview(notes: number) {
  return { ...localDataOverview(), notes }
}

describe('settings cache account isolation', () => {
  it('clears cached data on account changes and logout', () => {
    const user = { id: 'first', login: 'first', username: 'first', name: 'First', avatarUrl: '', role: 'owner' as const, createdAt: 0 }
    useSession.setState({ user, status: 'authed' })
    statsResource.set(overview(12))
    totpResource.set({ available: true, enabled: true, enabledAt: 1, recoveryCodesRemaining: 8 })
    useSession.setState({ user: { ...user, id: 'second' } })
    expect(statsResource.peek()).toBeNull()
    expect(totpResource.peek()).toBeNull()
    statsResource.set(overview(4))
    useSession.setState({ user: null, status: 'anonymous' })
    expect(statsResource.peek()).toBeNull()
  })
})
