import { OrderBookApiError } from '@cowprotocol/cow-sdk'
import { TaggedError } from '@ens-apps/utils/neverthrow'
import { Result } from 'neverthrow'
import {
  ContractFunctionRevertedError,
  decodeErrorResult,
  HttpRequestError,
  SocketClosedError,
  TimeoutError,
} from 'viem'
import { COW_TRADEABLE_ORDER_ABI } from './registration.cow-shed'

export const COW_SHED_RETRY_WINDOW_MS = 120_000

class CowShedOrderBookTransportError extends TaggedError(
  'CowShedOrderBookTransportError',
)<{ readonly cause: unknown }> {}

const FETCH_REJECTION_MESSAGES = [
  'Failed to fetch',
  'fetch failed',
  'Load failed',
  'Network request failed',
  'NetworkError when attempting to fetch resource.',
] as const

export const normalizeCowShedOrderBookFailure = (cause: unknown): unknown =>
  cause instanceof TypeError &&
  FETCH_REJECTION_MESSAGES.some((message) => message === cause.message)
    ? new CowShedOrderBookTransportError({ cause })
    : cause

export type CowShedFailure =
  | Readonly<{ kind: 'epoch'; timestamp: bigint }>
  | Readonly<{ kind: 'nextBlock' }>
  | Readonly<{ kind: 'transient'; retryAfterMs?: number }>
  | Readonly<{ kind: 'terminal' }>

const getRetryAfterMs = (value: string | null | undefined, now: number) => {
  if (!value) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) ? delay : undefined
  }
  if (!value.endsWith(' GMT')) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined
}

const classifyHttpFailure = (
  status: number | undefined,
  retryAfter: string | null | undefined,
  now: number,
): CowShedFailure =>
  status === undefined || status === 429 || (status >= 500 && status < 600)
    ? { kind: 'transient', retryAfterMs: getRetryAfterMs(retryAfter, now) }
    : { kind: 'terminal' }

const classifyPollingFailure = (
  cause: ContractFunctionRevertedError,
): CowShedFailure => {
  const decoded =
    cause.data ??
    Result.fromThrowable(() =>
      decodeErrorResult({
        abi: COW_TRADEABLE_ORDER_ABI,
        data: cause.raw ?? '0x',
      }),
    )().unwrapOr(undefined)
  if (decoded?.errorName === 'PollTryAtEpoch') {
    const timestamp = decoded.args?.[0]
    if (typeof timestamp === 'bigint') return { kind: 'epoch', timestamp }
  }
  return decoded?.errorName === 'PollTryNextBlock'
    ? { kind: 'nextBlock' }
    : { kind: 'terminal' }
}

export const classifyCowShedFailure = (
  cause: unknown,
  now: number,
  depth = 0,
): CowShedFailure => {
  if (depth >= 20) return { kind: 'terminal' }
  if (cause instanceof CowShedOrderBookTransportError)
    return { kind: 'transient' }
  if (cause instanceof ContractFunctionRevertedError)
    return classifyPollingFailure(cause)
  if (cause instanceof OrderBookApiError)
    return classifyHttpFailure(
      cause.response.status,
      cause.response.headers.get('Retry-After'),
      now,
    )
  if (cause instanceof HttpRequestError)
    return classifyHttpFailure(
      cause.status,
      cause.headers?.get('Retry-After'),
      now,
    )
  if (cause instanceof TimeoutError || cause instanceof SocketClosedError)
    return { kind: 'transient' }
  if (
    cause instanceof DOMException &&
    ['NetworkError', 'TimeoutError'].includes(cause.name)
  )
    return { kind: 'transient' }
  if (typeof cause === 'object' && cause !== null && 'cause' in cause)
    return classifyCowShedFailure(cause.cause, now, depth + 1)
  return { kind: 'terminal' }
}

export const getCowShedRetryDelay = (
  input: Readonly<{
    attempt: number
    now: number
    deadline: number
    retryAfterMs?: number
  }>,
): number | undefined => {
  const delay = Math.max(
    Math.min(input.attempt + 1, 3) * 5_000,
    input.retryAfterMs ?? 0,
  )
  return input.now + delay < input.deadline ? delay : undefined
}
