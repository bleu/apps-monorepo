import type { WalletProgress } from '@ens-apps/transaction-manager'
import { describe, expect, it } from 'vitest'
import { getWalletSigningView } from './walletSigning'

describe('getWalletSigningView', () => {
  it.each<{
    readonly action: WalletProgress['action']
    readonly phase: WalletProgress['phase']
    readonly label: string
    readonly description: string
  }>([
    {
      action: 'registrationHook',
      phase: 'awaitingSignature',
      label: 'Sign registration hook',
      description:
        "Sign to authorize registration of the name and removal of the Account Proxy's registration allowances. This message does not send a transaction.",
    },
    {
      action: 'setupHook',
      phase: 'awaitingSignature',
      label: 'Sign setup hook',
      description:
        'Sign to authorize the name commitment and the later registration order. It also allows CoW Swap to use the registration execution budget. This message does not send a transaction.',
    },
    {
      action: 'tokenPermit',
      phase: 'awaitingSignature',
      label: 'Sign {symbol} permit',
      description:
        'Sign to allow CoW Swap to spend {symbol} for this payment. This message does not send a transaction.',
    },
    {
      action: 'resetAllowance',
      phase: 'awaitingSignature',
      label: 'Reset {symbol} allowance',
      description:
        'Confirm a transaction that sets the current {symbol} spending allowance to zero. This transaction requires gas.',
    },
    {
      action: 'resetAllowance',
      phase: 'awaitingConfirmation',
      label: 'Confirming {symbol} allowance reset',
      description:
        'Waiting for the {symbol} allowance reset transaction to confirm.',
    },
    {
      action: 'tokenApproval',
      phase: 'awaitingSignature',
      label: 'Approve {symbol} for CoW Swap',
      description:
        'Confirm a transaction that allows CoW Swap to spend {symbol} for this payment. This transaction requires gas.',
    },
    {
      action: 'tokenApproval',
      phase: 'awaitingConfirmation',
      label: 'Confirming {symbol} approval',
      description: 'Waiting for the {symbol} approval transaction to confirm.',
    },
    {
      action: 'nativePayment',
      phase: 'awaitingSignature',
      label: 'Confirm ETH payment',
      description:
        'Confirm the ETH payment in your wallet. This transaction spends ETH and requires gas.',
    },
    {
      action: 'nativePayment',
      phase: 'awaitingConfirmation',
      label: 'Confirming ETH payment',
      description: 'Waiting for the ETH payment transaction to confirm.',
    },
    {
      action: 'paymentOrder',
      phase: 'awaitingSignature',
      label: 'Sign and submit payment order',
      description:
        'Sign the CoW Swap order to exchange {symbol} for the USDC needed for registration. Signing does not send a transaction. This step also waits for order submission.',
    },
  ])(
    'describes $action during $phase',
    ({ action, phase, label, description }) => {
      const view = getWalletSigningView({
        token: { symbol: 'USDT' },
        progress: { action, phase },
      })
      expect(view?.label.message).toBe(label)
      expect(view?.description.message).toBe(description)
      expect(view?.label.values ?? {}).toEqual(
        label.includes('{symbol}') ? { symbol: 'USDT' } : {},
      )
      expect(view?.description.values ?? {}).toEqual(
        description.includes('{symbol}') ? { symbol: 'USDT' } : {},
      )
    },
  )

  it('clears the request copy when the action completes', () => {
    expect(
      getWalletSigningView({
        token: { symbol: 'USDT' },
        progress: { action: 'tokenApproval', phase: 'completed' },
      }),
    ).toBeUndefined()
  })
})
