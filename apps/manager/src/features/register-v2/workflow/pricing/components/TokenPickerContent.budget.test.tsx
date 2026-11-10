import '@testing-library/jest-dom'
import { NATIVE_ETH } from '@ens-apps/transaction-manager'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HCA_PAYMENT_TOKEN } from '@/lib/smart-account/useSmartAccountBalances'

// Drives the connected `TokenPickerContent`, so the budget-failure flag is
// derived from a real budget query rather than handed in as a prop.

const smartAccountMock = vi.hoisted(() => ({
  useSmartAccountContext: vi.fn(),
  paymentAsset: 'wallet',
}))

vi.mock('@/lib/smart-account/SmartAccountContext', () => smartAccountMock)

vi.mock('../../../state/registrationUi.context', () => ({
  useRegistrationV2Context: () => ({ label: 'jeff', uiActor: {} }),
}))

vi.mock('@xstate/react', () => ({
  useSelector: (
    _actor: unknown,
    select: (state: {
      matches: () => boolean
      context: { duration: number; selectedToken: string; paymentAsset: string }
    }) => unknown,
  ) =>
    _actor
      ? select({
          matches: () => false,
          context: {
            duration: 31_536_000,
            selectedToken: 'USDC',
            paymentAsset: smartAccountMock.paymentAsset,
          },
        })
      : undefined,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useSearch: () => ({ referrer: '0x1234' }),
}))

vi.mock('../../../data/queries/pricing.query', () => ({
  getRegisterPriceQueryOptions: () => ({
    queryKey: ['register-price'],
    queryFn: async () => ({ basePrice: 330_000_000n, premium: 0n }),
  }),
}))

vi.mock('@/features/profile/service/profileReverseName', () => ({
  profileReverseNameQuery: () => ({
    queryKey: ['reverse-name'],
    queryFn: async () => null,
    enabled: false,
  }),
}))

vi.mock('@/features/shared/service/ownedNamesCount', () => ({
  ownedNamesCountQueryOptions: () => ({
    queryKey: ['owned-names-count'],
    queryFn: async () => 0,
    enabled: false,
  }),
}))

vi.mock('../hooks/useCowPaymentTokens', () => ({
  useCowPaymentTokens: () => ({
    data: [{ ...NATIVE_ETH, balance: 10n ** 18n }],
    isLoading: false,
  }),
}))

vi.mock('../../../data/queries/ethPaymentQuote.query', () => ({
  getEthPaymentQuoteQueryOptions: ({ isEnabled }: { isEnabled: boolean }) => ({
    queryKey: ['eth-payment-quote'],
    enabled: isEnabled,
    queryFn: async () => ({
      swap: { maximumSell: 165_500_000_000_000_000n },
      walletBalance: 10n ** 18n,
      gasReserve: 0n,
      ethUsd: 200_000_000_000n,
      cowShed: {
        executionBudget: 1_000_000n,
        firstOrderValidTo: 1_800_000_300,
      },
    }),
  }),
}))

import { TokenPickerContent } from './TokenPickerContent'

i18n.loadAndActivate({ locale: 'en', messages: {} })

const QUOTE_FAILED_MESSAGE =
  "We couldn't calculate the total. Please try again."

/** 1,000 USDC — comfortably above the 330 rent. */
const usdc = {
  address: HCA_PAYMENT_TOKEN,
  symbol: 'USDC',
  decimals: 6,
  balance: '1000000000',
}

const mockAccount = (
  overrides: Partial<{
    signer: { type: string } | null
    accountAddress: string | null
    ownerAddress: string | null
  }> = {},
) =>
  smartAccountMock.useSmartAccountContext.mockReturnValue({
    accountAddress: '0x000000000000000000000000000000000000dEaD',
    ownerAddress: null,
    signer: { type: 'rhinestone', account: { config: {} } },
    stablecoinBalances: [usdc],
    isLoadingBalances: false,
    isConnected: true,
    // The first thing the budget quote awaits, so rejecting it fails the
    // query through its real `queryFn`.
    getSessionEnablePayload: vi
      .fn()
      .mockRejectedValue(new Error('orchestrator unavailable')),
    ...overrides,
  })

const renderConnectedPicker = () => {
  const queryClient = new QueryClient({
    // The budget query retries once; don't wait out the backoff.
    defaultOptions: { queries: { retryDelay: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <TokenPickerContent />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('TokenPickerContent budget quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    smartAccountMock.paymentAsset = 'wallet'
  })

  it('shows the EOA token-payment receipt without an HCA budget', async () => {
    smartAccountMock.paymentAsset = 'eth'
    mockAccount({
      signer: { type: 'eoa' },
      accountAddress: null,
      ownerAddress: '0x1111111111111111111111111111111111111111',
    })
    renderConnectedPicker()

    await waitFor(() => {
      expect(
        screen.getByText('Registration total').nextElementSibling,
      ).toHaveTextContent('$330.00')
      expect(
        screen.getByText('Estimated network fee').nextElementSibling,
      ).toHaveTextContent('$1.00')
      expect(screen.getByText('You pay').nextElementSibling).toHaveTextContent(
        '$331.00',
      )
    })
    expect(
      screen.getByRole('region', { name: 'Payment summary' }),
    ).toHaveAttribute('aria-busy', 'false')
  })

  it('blocks checkout on the HCA route when the budget query errors', async () => {
    mockAccount()
    renderConnectedPicker()

    // The wallet covers the rent, so only the failed quote can block here.
    expect(await screen.findByText(QUOTE_FAILED_MESSAGE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: /approv|register/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('$330.00')).not.toBeInTheDocument()
  })

  it('does not gate the EOA route, which never quotes a budget', async () => {
    mockAccount({ signer: { type: 'eoa' }, accountAddress: null })
    renderConnectedPicker()

    // Enabled once the rent lands; the budget query never runs on this route.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve and register' }),
      ).toBeEnabled(),
    )
    expect(screen.queryByText(QUOTE_FAILED_MESSAGE)).not.toBeInTheDocument()
  })
})
