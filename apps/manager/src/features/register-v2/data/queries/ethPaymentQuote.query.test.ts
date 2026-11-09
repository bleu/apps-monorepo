import { NATIVE_ETH } from '@ens-apps/transaction-manager'
import { QueryClient } from '@tanstack/react-query'
import { okAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { getEthPaymentQuoteQueryOptions } from './ethPaymentQuote.query'

const mocks = vi.hoisted(() => ({
  shedQuote: vi.fn(),
  legacyQuote: vi.fn(),
}))
vi.mock(
  '@ens-apps/transaction-manager/machines/registration/registration.cow-shed.actors',
  () => ({
    quoteCowShedPaymentActor: mocks.shedQuote,
  }),
)
vi.mock('@ens-apps/transaction-manager', async (original) => ({
  ...(await original<typeof import('@ens-apps/transaction-manager')>()),
  quoteEthPaymentActor: mocks.legacyQuote,
  quoteEthSwapGasReserve: () => okAsync(100n),
  readEthUsdPrice: () => okAsync(300_000_000_000n),
}))
vi.mock('@/config', () => ({ chain: { id: 11155111 } }))
vi.mock('@/lib/wagmi', () => ({
  publicClient: { getBalance: async () => 10_000n },
}))

const owner = '0x1111111111111111111111111111111111111111' as const

describe('registration payment quote', () => {
  it('quotes name price plus execution budget for EOA Sepolia and keeps the signed timing', async () => {
    mocks.shedQuote.mockReturnValue(
      okAsync({
        usdcToBuy: 5_250_000n,
        swap: { maximumSell: 2000n, maximumEth: 2000n },
        executionBudget: 250_000n,
        firstOrderValidTo: 1_800_000_300,
      }),
    )
    mocks.legacyQuote.mockReturnValue(okAsync({ usdcToBuy: 5_000_000n }))
    const quote = await new QueryClient().fetchQuery(
      getEthPaymentQuoteQueryOptions({
        owner,
        receiver: owner,
        sellToken: NATIVE_ETH,
        permitValue: 5_000_000n,
        includeRegistrationHooks: true,
        isEnabled: true,
      }),
    )

    expect(quote).toMatchObject({
      usdcToBuy: 5_250_000n,
      swap: { maximumSell: 2000n },
      cowShed: {
        executionBudget: 250_000n,
        firstOrderValidTo: 1_800_000_300,
      },
    })
    expect(mocks.legacyQuote).not.toHaveBeenCalled()
  })
})
