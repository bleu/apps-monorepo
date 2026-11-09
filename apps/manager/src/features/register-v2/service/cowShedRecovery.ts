import {
  type PersistedRegistrationRecord,
  serializeRegistrationRecord,
} from '@ens-apps/transaction-manager'
import { TaggedError } from '@ens-apps/utils/neverthrow'
import type { Address } from 'viem'

export class CowShedRecoveryError extends TaggedError('CowShedRecoveryError')<{
  readonly cause: unknown
  readonly message: string
}> {}

export const COW_SHED_RECOVERY_STORAGE_PREFIX = 'ens-apps:register-v2:cow-shed:'

const recoveryKey = (chainId: number, owner: Address) =>
  `${COW_SHED_RECOVERY_STORAGE_PREFIX}${chainId}:${owner.toLowerCase()}`

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>

export function saveCowShedRecovery(
  record: PersistedRegistrationRecord,
  storage: RecoveryStorage = globalThis.localStorage,
): void {
  const owner = record.context.ownerAddress
  const progress = record.context.cowShedRun
  if (!owner || !progress)
    throw new CowShedRecoveryError({
      cause: { hasOwner: Boolean(owner), hasProgress: Boolean(progress) },
      message: 'CoW Shed recovery details are missing',
    })
  const key = recoveryKey(record.context.chainId, owner)
  const serialized = serializeRegistrationRecord(record)
  storage.setItem(key, serialized)
  if (storage.getItem(key) !== serialized)
    throw new CowShedRecoveryError({
      cause: key,
      message: 'CoW Shed recovery data was not saved',
    })
}
