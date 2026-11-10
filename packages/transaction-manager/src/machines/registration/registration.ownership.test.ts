import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { getRegistrationOwnership } from './registration.ownership'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'

describe('getRegistrationOwnership', () => {
  it.each([
    [0, OWNER],
    [0, OTHER_OWNER],
    [1, zeroAddress],
  ] as const)(
    'treats status %s with historical owner %s as unregistered',
    (status, latestOwner) => {
      expect(
        getRegistrationOwnership({
          state: { status, latestOwner },
          expectedOwner: OWNER,
        }),
      ).toEqual({
        owner: zeroAddress,
        registeredToOther: false,
        isUnregistered: true,
      })
    },
  )
})
