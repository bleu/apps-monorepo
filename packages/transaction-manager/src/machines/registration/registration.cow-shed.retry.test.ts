import { OrderBookApiError } from '@cowprotocol/cow-sdk'
import {
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  classifyCowShedFailure,
  getCowShedRetryDelay,
  normalizeCowShedOrderBookFailure,
} from './registration.cow-shed.retry'

const apiError = (status: number, retryAfter?: string) =>
  new OrderBookApiError(
    new Response('', {
      status,
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }),
    { errorType: 'RequestFailed' },
  )

describe('CoW failure policy', () => {
  it.each([
    'Failed to fetch',
    'fetch failed',
    'Load failed',
    'Network request failed',
    'NetworkError when attempting to fetch resource.',
  ])('normalizes a known order-book fetch rejection: %s', (message) => {
    const cause = new TypeError(message)
    const normalized = normalizeCowShedOrderBookFailure(cause)
    expect(classifyCowShedFailure(normalized, 0)).toEqual({ kind: 'transient' })
    expect(normalized).toMatchObject({ cause })
  })

  it.each([
    new TypeError('Cannot read properties of undefined'),
    new Error('Failed to fetch'),
    new SyntaxError('Invalid JSON'),
  ])('keeps an unrelated order-book failure terminal: %o', (cause) => {
    expect(normalizeCowShedOrderBookFailure(cause)).toBe(cause)
    expect(
      classifyCowShedFailure(normalizeCowShedOrderBookFailure(cause), 0),
    ).toEqual({ kind: 'terminal' })
  })

  it.each([
    [apiError(429, '20'), { kind: 'transient', retryAfterMs: 20_000 }],
    [apiError(503), { kind: 'transient' }],
    [
      new TimeoutError({ body: {}, url: 'https://rpc.test' }),
      { kind: 'transient' },
    ],
    [
      new Error('wrapped', {
        cause: new HttpRequestError({ status: 502, url: 'https://rpc.test' }),
      }),
      { kind: 'transient' },
    ],
    [apiError(400), { kind: 'terminal' }],
    [apiError(401), { kind: 'terminal' }],
    [apiError(404), { kind: 'terminal' }],
    [new Error('PollTryAtEpoch commitment too new'), { kind: 'terminal' }],
    [new TypeError('Failed to fetch'), { kind: 'terminal' }],
    [
      new ContractFunctionRevertedError({
        abi: [],
        functionName: 'read',
        data: '0x12345678',
      }),
      { kind: 'terminal' },
    ],
  ])('classifies %o', (cause, expected) => {
    expect(classifyCowShedFailure(cause, 0)).toEqual(expected)
  })

  it.each([
    ['Thu, 01 Jan 1970 00:01:00 GMT', 50_000],
    ['not a date', undefined],
    ['-1', undefined],
  ])(
    'uses a valid Retry-After without reading the clock: %s',
    (header, retryAfterMs) => {
      expect(classifyCowShedFailure(apiError(429, header), 10_000)).toEqual({
        kind: 'transient',
        retryAfterMs,
      })
    },
  )

  it.each([
    [0, 0, undefined, 5_000],
    [1, 5_000, undefined, 10_000],
    [2, 15_000, undefined, 15_000],
    [8, 30_000, 20_000, 20_000],
    [8, 110_000, undefined, undefined],
    [0, 0, 120_000, undefined],
    [0, 120_000, undefined, undefined],
  ])('bounds attempt %s at %s', (attempt, now, retryAfterMs, expected) => {
    expect(
      getCowShedRetryDelay({ attempt, now, deadline: 120_000, retryAfterMs }),
    ).toBe(expected)
  })
})
