import { describe, expect, it } from 'vitest'
import { getCowShedReadiness } from './registration.cow-shed.readiness'

describe('getCowShedReadiness', () => {
  it.each([
    { committedAt: 0n, timestamp: 1_500n, expected: 'missing' },
    { committedAt: 1_000n, timestamp: 1_500n, expected: 'ready' },
    {
      committedAt: 1_000n,
      timestamp: 1_501n,
      expected: 'authorizationExpired',
    },
    { committedAt: 1_400n, timestamp: 1_500n, expected: 'waiting' },
  ])(
    'checks missing, replaced commitments and inclusive expiry: %o',
    ({ committedAt, timestamp, expected }) => {
      expect(
        getCowShedReadiness({
          timestamp,
          committedAt,
          minAge: 300n,
          maxAge: 1_000n,
          validTo: 1_500n,
        }),
      ).toBe(expected)
    },
  )

  it.each([
    { timestamp: 1_299n, expected: 'waiting' },
    { timestamp: 1_300n, expected: 'ready' },
    { timestamp: 1_999n, expected: 'ready' },
    { timestamp: 2_000n, expected: 'commitmentExpired' },
  ])(
    'uses the live commitment window at $timestamp',
    ({ timestamp, expected }) => {
      expect(
        getCowShedReadiness({
          timestamp,
          committedAt: 1_000n,
          minAge: 300n,
          maxAge: 1_000n,
          validTo: 3_000n,
        }),
      ).toBe(expected)
    },
  )
})
