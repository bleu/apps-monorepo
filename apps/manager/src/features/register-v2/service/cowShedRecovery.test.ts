import {
  buildRegistrationRecord,
  serializeRegistrationRecord,
} from '@ens-apps/transaction-manager'
import { ENS_COMMITMENT } from '@ens-apps/transaction-manager/machines/registration/registration.cow-shed'
import type { CowShedProgress } from '@ens-apps/transaction-manager/machines/registration/registration.cow-shed.actors'
import { describe, expect, it } from 'vitest'
import {
  COW_SHED_RECOVERY_STORAGE_PREFIX,
  saveCowShedRecovery,
} from './cowShedRecovery'
import { REGISTRATION_RESUME_STORAGE_KEY } from './registrationPersistence'

const owner = '0x1111111111111111111111111111111111111111' as const
const hash = `0x${'11'.repeat(32)}` as const
const otherSalt = `0x${'22'.repeat(32)}` as const
const progress: CowShedProgress = {
  stage: 'prepared',
  plan: {
    authorization: {
      chainId: 11155111,
      wallet: owner,
      resolver: owner,
      name: 'first.eth',
      duration: 31_536_000n,
      secret: hash,
      commitment: hash,
      registrationPrice: 5_000_000n,
      executionBudget: 250_000n,
      firstOrderValidTo: 1_900_000_000n,
      secondOrderValidTo: 1_900_004_000n,
      salt: hash,
      setupNonce: hash,
      registrationNonce: hash,
    },
    signed: {
      cowShedAccount: owner,
      firstOrderAmountOut: 5_250_000n,
      conditionalOrder: {
        handler: ENS_COMMITMENT,
        salt: hash,
        staticInput: '0x',
      },
      registrationAppData: { appDataContent: '{}', appDataHex: hash },
      registrationHook: { target: owner, callData: '0x', gasLimit: 1_000_000 },
      setupHook: { target: owner, callData: '0x', gasLimit: 1_000_000 },
    },
    sellToken: {
      address: owner,
      symbol: 'TOKEN',
      decimals: 18,
      isNative: false,
    },
    maximumSell: 1000n,
  },
}
const record = () =>
  buildRegistrationRecord(
    'runningCowShedRegistration',
    {
      chainId: 11155111,
      name: 'first.eth',
      ownerAddress: owner,
      duration: 31_536_000n,
      selectedToken: 'USDC',
      tokenPrice: 5_000_000n,
      cowShedRun: progress,
    },
    1,
  )
const makeStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

describe('Shed recovery across names', () => {
  it('saves current progress over unreadable prior recovery and primary data', () => {
    const storage = makeStorage()
    const key = `${COW_SHED_RECOVERY_STORAGE_PREFIX}11155111:${owner}`
    storage.setItem(key, '{ unreadable recovery')
    storage.setItem(REGISTRATION_RESUME_STORAGE_KEY, '{ unreadable primary')
    const current = record()

    saveCowShedRecovery(current, storage)

    expect(storage.getItem(key)).toBe(serializeRegistrationRecord(current))
  })

  it('saves a different registration while earlier signed hooks remain valid', () => {
    const storage = makeStorage()
    saveCowShedRecovery(record(), storage)
    const prior = record()
    const next = {
      ...prior,
      context: {
        ...prior.context,
        name: 'second.eth',
        cowShedRun: {
          ...progress,
          plan: {
            ...progress.plan,
            authorization: {
              ...progress.plan.authorization,
              name: 'second.eth',
              salt: otherSalt,
            },
          },
        },
      },
    }
    saveCowShedRecovery(next, storage)
    expect(
      storage.getItem(`${COW_SHED_RECOVERY_STORAGE_PREFIX}11155111:${owner}`),
    ).toBe(serializeRegistrationRecord(next))
  })

  it('refuses outward submission when storage does not retain the write', () => {
    expect(() =>
      saveCowShedRecovery(record(), {
        getItem: () => null,
        setItem: () => undefined,
      }),
    ).toThrow('was not saved')
  })
})
