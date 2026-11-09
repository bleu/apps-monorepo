/**
 * localStorage backing for an interrupted registration.
 *
 * The shared package (`@ens-apps/transaction-manager`) owns the machine-context
 * half of the record and its bigint-safe codec; this module owns the app half —
 * which label the record belongs to, and the pricing the user already confirmed
 * — plus the actual storage.
 *
 * ONE record, last-writer-wins. Starting a registration for a different label
 * overwrites the previous one: a user mid-cooldown on `alice` who goes and
 * registers `bob` has made their choice, and carrying two records would mean
 * two commitments to reconcile on every mount.
 *
 * Storage is best-effort throughout. A private-mode browser or a full quota
 * costs the user resume, not the registration — every failure degrades to "no
 * stored record" rather than throwing. (Contrast `migrationBatchJournal.ts`,
 * which DOES throw: there, losing the journal risks a double-submit.)
 */

import type {
  PersistedRegistrationRecord,
  RegistrationPersistenceAdapter,
} from '@ens-apps/transaction-manager'
import {
  parseRegistrationRecord,
  serializeRegistrationRecord,
} from '@ens-apps/transaction-manager'
import * as v from 'valibot'
import type { Address } from 'viem'
import { type SUPPORTED_TOKEN, SUPPORTED_TOKENS } from '@/lib/tokens'
import type { RegistrationPostRegistrationSetup } from '../state/registrationAutoSetup'
import type { RegistrationConfirmedData } from '../state/registrationUi.machine'

/**
 * Bump when {@link StoredRegistrationEnvelope} changes shape, or when stored
 * runs can no longer complete (v2: the payment token moved to Circle USDC).
 */
export const REGISTRATION_RESUME_VERSION = 2

/** Exported so the disconnect-time storage sweep can leave the record alone. */
export const REGISTRATION_RESUME_STORAGE_KEY = 'ens-apps:register-v2:resume:v1'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type StoredRegistration = {
  readonly label: string
  /** The machine-context half, already validated by the package codec. */
  readonly record: PersistedRegistrationRecord
  /**
   * What the user confirmed at the pricing step. Not derivable from the machine
   * context — `basePriceNumber` / `premiumPriceNumber` are display values — and
   * the UI machine needs them to render the registering screen on resume.
   */
  readonly confirmedData: RegistrationConfirmedData
  /**
   * The auto-setup opt-in (primary name / eth-record sync).
   *
   * The HCA path folds this into the reveal batch, so `context.primaryName`
   * covers it there. The EOA path runs it as separate post-registration
   * transactions off UI-machine state alone — without persisting it, an EOA
   * resume would silently drop the primary name the user asked for.
   */
  readonly postRegistrationSetup?: RegistrationPostRegistrationSetup
}

/** What the adapter reads off the parent UI machine at write time. */
export type RegistrationAppState = {
  readonly confirmedData?: RegistrationConfirmedData
  readonly postRegistrationSetup?: RegistrationPostRegistrationSetup
}

const addressSchema = v.custom<Address>(
  (input) => typeof input === 'string' && /^0x[0-9a-fA-F]{40}$/.test(input),
)

// bigints are written as decimal strings rather than reusing the package's
// `{__bigint}` envelope: there are exactly two of them here, and being explicit
// keeps this file from needing a codec of its own.
const bigintStringSchema = v.pipe(v.string(), v.regex(/^\d+$/))

const confirmedDataSchema = v.object({
  label: v.string(),
  duration: bigintStringSchema,
  referrer: v.optional(
    v.custom<`0x${string}`>(
      (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
    ),
  ),
  ownerAddress: addressSchema,
  token: v.picklist(Object.keys(SUPPORTED_TOKENS) as SUPPORTED_TOKEN[]),
  totalPrice: bigintStringSchema,
  basePriceNumber: v.number(),
  premiumPriceNumber: v.number(),
})

const postRegistrationSetupSchema = v.object({
  primaryName: v.optional(
    v.object({
      enabled: v.boolean(),
      syncEthRecord: v.optional(v.boolean()),
    }),
  ),
})

const envelopeSchema = v.object({
  v: v.number(),
  label: v.string(),
  /** The package record, kept as its own JSON string so its codec stays authoritative. */
  record: v.string(),
  confirmedData: confirmedDataSchema,
  postRegistrationSetup: v.optional(postRegistrationSetupSchema),
})

type StoredRegistrationEnvelope = v.InferOutput<typeof envelopeSchema>

const getBrowserStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const encodeConfirmedData = (
  confirmedData: RegistrationConfirmedData,
): StoredRegistrationEnvelope['confirmedData'] => ({
  label: confirmedData.label,
  duration: confirmedData.duration.toString(),
  referrer: confirmedData.referrer,
  ownerAddress: confirmedData.ownerAddress,
  token: confirmedData.token,
  totalPrice: confirmedData.totalPrice.toString(),
  basePriceNumber: confirmedData.basePriceNumber,
  premiumPriceNumber: confirmedData.premiumPriceNumber,
})

const decodeConfirmedData = (
  stored: StoredRegistrationEnvelope['confirmedData'],
): RegistrationConfirmedData => ({
  label: stored.label,
  duration: BigInt(stored.duration),
  referrer: stored.referrer,
  ownerAddress: stored.ownerAddress,
  token: stored.token,
  totalPrice: BigInt(stored.totalPrice),
  basePriceNumber: stored.basePriceNumber,
  premiumPriceNumber: stored.premiumPriceNumber,
})

/** Return the current-format record, or null when it cannot resume. */
export function loadStoredRegistration(
  storage: StorageLike | null = getBrowserStorage(),
): StoredRegistration | null {
  if (!storage) return null

  let parsed: unknown
  try {
    const raw = storage.getItem(REGISTRATION_RESUME_STORAGE_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const envelope = v.safeParse(envelopeSchema, parsed)
  if (!envelope.success) return null
  if (envelope.output.v !== REGISTRATION_RESUME_VERSION) return null

  const record = parseRegistrationRecord(envelope.output.record)
  if (record.isErr()) return null

  // The commitment binds the name, so mismatched labels cannot resume.
  const contextLabel = record.value.context.name.replace(/\.eth$/, '')
  if (
    contextLabel !== envelope.output.label ||
    envelope.output.confirmedData.label !== envelope.output.label
  ) {
    return null
  }

  return {
    label: envelope.output.label,
    record: record.value,
    confirmedData: decodeConfirmedData(envelope.output.confirmedData),
    postRegistrationSetup: envelope.output.postRegistrationSetup,
  }
}

type CowShedRunIdentity = Pick<
  PersistedRegistrationRecord['context'],
  'chainId' | 'name' | 'ownerAddress' | 'commitment'
>

const failedCowShedRegistration = (
  stored: StoredRegistration | null,
  context: CowShedRunIdentity,
): StoredRegistration | null => {
  if (
    !stored?.record.context.cowShedRun ||
    !context.commitment ||
    stored.record.context.commitment?.commitment !==
      context.commitment.commitment ||
    stored.record.context.chainId !== context.chainId ||
    stored.record.context.name !== context.name ||
    stored.record.context.ownerAddress?.toLowerCase() !==
      context.ownerAddress?.toLowerCase()
  )
    return null
  return { ...stored, record: { ...stored.record, stage: 'error' } }
}

export function markStoredCowShedRegistrationFailed(
  context: CowShedRunIdentity,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  const failed = failedCowShedRegistration(
    loadStoredRegistration(storage),
    context,
  )
  if (!failed) return
  createRegistrationPersistenceAdapter({
    label: failed.label,
    getAppState: () => failed,
    storage,
  }).save(failed.record)
}

export function clearStoredRegistration(
  storage: StorageLike | null = getBrowserStorage(),
): void {
  try {
    storage?.removeItem(REGISTRATION_RESUME_STORAGE_KEY)
  } catch {
    // Nothing to do: a record we cannot delete is one the preflight will
    // reject anyway, and failing here would break the flow that called us.
  }
}

/**
 * One write of the stored record. Every save stamps a fresh `updatedAt`, so
 * any later write, by the same run or another tab's, no longer matches.
 */
export type StoredRegistrationKey = {
  readonly label: string
  readonly updatedAt: number
}

export const storedRegistrationKey = (
  stored: StoredRegistration,
): StoredRegistrationKey => ({
  label: stored.label,
  updatedAt: stored.record.updatedAt,
})

/**
 * Clear the stored record only if it is still the write `key` names. Since
 * then another tab may have resumed or restarted the name, and its record
 * holds the only copy of the secret for its commitment.
 */
export function clearStoredRegistrationIfUnchanged(
  key: StoredRegistrationKey,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  const stored = loadStoredRegistration(storage)
  if (stored?.record.context.cowShedRun) return
  if (
    stored?.label !== key.label ||
    stored.record.updatedAt !== key.updatedAt
  ) {
    return
  }
  clearStoredRegistration(storage)
}

/**
 * Whether a record was written by a run that ended in failure.
 *
 * The package keeps such a record, minus a run the user declined, because a
 * failed register does not mean a failed commitment: the record still holds
 * the secret that reveals one already on-chain. The Manager restores it to the
 * failure screen rather than resuming it, so nothing re-runs until the user
 * presses Try Again.
 */
export function isFailedRegistrationRecord(
  record: Pick<PersistedRegistrationRecord, 'stage'>,
): boolean {
  return record.stage === 'error'
}

/**
 * Build the adapter that `subscribeRegistrationPersistence` writes through.
 *
 * `getConfirmedData` is a callback rather than a value because the subscriber
 * fires on the child machine's snapshots, while the confirmed pricing lives on
 * the parent UI machine — the adapter reads it at write time.
 *
 * A save with no confirmed data is dropped rather than stored: a record that
 * cannot repopulate the registering screen is not resumable, and a half-record
 * would shadow whatever complete one preceded it.
 */
export function createRegistrationPersistenceAdapter(options: {
  label: string
  getAppState: () => RegistrationAppState | undefined
  storage?: StorageLike | null
  requireDurableSave?: boolean
}): RegistrationPersistenceAdapter {
  const storage =
    options.storage === undefined ? getBrowserStorage() : options.storage

  return {
    save(record) {
      if (!storage) {
        if (options.requireDurableSave)
          throw new Error('Registration recovery storage is unavailable')
        return
      }

      const appState = options.getAppState()
      if (!appState?.confirmedData) {
        if (options.requireDurableSave)
          throw new Error('Registration recovery pricing is unavailable')
        return
      }

      const envelope: StoredRegistrationEnvelope = {
        v: REGISTRATION_RESUME_VERSION,
        label: options.label,
        record: serializeRegistrationRecord(record),
        confirmedData: encodeConfirmedData(appState.confirmedData),
        postRegistrationSetup: appState.postRegistrationSetup,
      }

      try {
        storage.setItem(
          REGISTRATION_RESUME_STORAGE_KEY,
          JSON.stringify(envelope),
        )
      } catch (cause) {
        if (options.requireDurableSave) throw cause
        // Quota or private mode. The user loses resume, not the registration.
      }
    },

    load() {
      return loadStoredRegistration(storage)?.record ?? null
    },

    clear() {
      clearStoredRegistration(storage)
    },
  }
}
