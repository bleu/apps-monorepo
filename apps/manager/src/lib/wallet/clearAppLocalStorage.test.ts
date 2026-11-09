import { afterEach, describe, expect, it } from 'vitest'
import { COW_SHED_RECOVERY_STORAGE_PREFIX } from '@/features/register-v2/service/cowShedRecovery'
import { REGISTRATION_RESUME_STORAGE_KEY } from '@/features/register-v2/service/registrationPersistence'
import { clearAppLocalStorage } from './clearAppLocalStorage'

describe('clearAppLocalStorage', () => {
  afterEach(() => localStorage.clear())

  it('keeps an interrupted registration for its owner to resume', () => {
    // A disconnect suspends the run and leaves this record for the reconnect.
    // Sweeping it meant the owner came back to plain pricing.
    localStorage.setItem(REGISTRATION_RESUME_STORAGE_KEY, '{"v":1}')

    clearAppLocalStorage()

    expect(localStorage.getItem(REGISTRATION_RESUME_STORAGE_KEY)).toBe(
      '{"v":1}',
    )
  })

  it('keeps signed Shed hook recovery across disconnect', () => {
    const key = `${COW_SHED_RECOVERY_STORAGE_PREFIX}11155111:0x1111111111111111111111111111111111111111`
    localStorage.setItem(key, 'signed hook recovery')

    clearAppLocalStorage()

    expect(localStorage.getItem(key)).toBe('signed hook recovery')
  })

  it('keeps the wallet connection and HCA sessions, and clears the rest', () => {
    localStorage.setItem('wagmi.store', 'connection')
    localStorage.setItem('ens-sessions-0xabc', 'session')
    localStorage.setItem('search-history', 'app state')

    clearAppLocalStorage()

    expect(localStorage.getItem('wagmi.store')).toBe('connection')
    expect(localStorage.getItem('ens-sessions-0xabc')).toBe('session')
    expect(localStorage.getItem('search-history')).toBeNull()
  })
})
