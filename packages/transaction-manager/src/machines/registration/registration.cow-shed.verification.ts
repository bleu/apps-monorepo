import { ResultFn } from '@ens-apps/utils/neverthrow'
import { type Err, err, errAsync, ResultAsync } from 'neverthrow'
import {
  sleepUnlessAborted,
  verifyRegistrationActor,
} from './registration.actors'
import {
  COW_SHED_RETRY_WINDOW_MS,
  classifyCowShedFailure,
  getCowShedRetryDelay,
} from './registration.cow-shed.retry'

type VerificationInput = Readonly<Parameters<typeof verifyRegistrationActor>[0]>
type VerificationResult = Awaited<ReturnType<typeof verifyRegistrationActor>>

const getAbortError = (reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new Error('Registration verification aborted')

export function verifyCowShedRegistrationActor(
  input: VerificationInput,
): ReturnType<typeof verifyRegistrationActor> {
  if (input.signal?.aborted) {
    return errAsync(getAbortError(input.signal.reason))
  }

  const deadline =
    Date.now() +
    Math.min(
      input.graceWindowMs ?? COW_SHED_RETRY_WINDOW_MS,
      COW_SHED_RETRY_WINDOW_MS,
    )

  const verify = ResultFn(async function* (
    attempt: number,
  ): AsyncGenerator<Err<never, never>, VerificationResult, never> {
    const result = await verifyRegistrationActor({
      ...input,
      graceWindowMs: Math.max(0, deadline - Date.now()),
    })
    if (input.signal?.aborted) return err(getAbortError(input.signal.reason))
    if (result.isOk()) return result

    const failure = classifyCowShedFailure(result.error, Date.now())
    if (failure.kind !== 'transient') return result

    const delay = getCowShedRetryDelay({
      attempt,
      now: Date.now(),
      deadline,
      retryAfterMs: failure.retryAfterMs,
    })
    if (delay === undefined) return result

    yield* ResultAsync.fromSafePromise(sleepUnlessAborted(delay, input.signal))
    if (input.signal?.aborted) return err(getAbortError(input.signal.reason))
    if (Date.now() >= deadline) return result

    return await verify(attempt + 1)
  })

  return verify(0)
}
