import type {
  CowSellToken,
  WalletProgress,
} from '@ens-apps/transaction-manager'
import { msg } from '@lingui/core/macro'
import { match } from 'ts-pattern'

export interface WalletSigningInput {
  readonly token: Pick<CowSellToken, 'symbol'>
  readonly progress: WalletProgress
}

export const getWalletSigningView = ({
  token: { symbol },
  progress: { action, phase },
}: WalletSigningInput) => {
  if (phase === 'completed') return undefined
  return match({ action, phase })
    .with({ action: 'registrationHook' }, () => ({
      label: msg`Sign registration hook`,
      description: msg`Sign to authorize registration of the name and removal of the Account Proxy's registration allowances. This message does not send a transaction.`,
    }))
    .with({ action: 'setupHook' }, () => ({
      label: msg`Sign setup hook`,
      description: msg`Sign to authorize the name commitment and the later registration order. It also allows CoW Swap to use the registration execution budget. This message does not send a transaction.`,
    }))
    .with({ action: 'tokenPermit' }, () => ({
      label: msg`Sign ${symbol} permit`,
      description: msg`Sign to allow CoW Swap to spend ${symbol} for this payment. This message does not send a transaction.`,
    }))
    .with({ action: 'resetAllowance', phase: 'awaitingConfirmation' }, () => ({
      label: msg`Confirming ${symbol} allowance reset`,
      description: msg`Waiting for the ${symbol} allowance reset transaction to confirm.`,
    }))
    .with({ action: 'resetAllowance' }, () => ({
      label: msg`Reset ${symbol} allowance`,
      description: msg`Confirm a transaction that sets the current ${symbol} spending allowance to zero. This transaction requires gas.`,
    }))
    .with({ action: 'tokenApproval', phase: 'awaitingConfirmation' }, () => ({
      label: msg`Confirming ${symbol} approval`,
      description: msg`Waiting for the ${symbol} approval transaction to confirm.`,
    }))
    .with({ action: 'tokenApproval' }, () => ({
      label: msg`Approve ${symbol} for CoW Swap`,
      description: msg`Confirm a transaction that allows CoW Swap to spend ${symbol} for this payment. This transaction requires gas.`,
    }))
    .with({ action: 'nativePayment', phase: 'awaitingConfirmation' }, () => ({
      label: msg`Confirming ETH payment`,
      description: msg`Waiting for the ETH payment transaction to confirm.`,
    }))
    .with({ action: 'nativePayment' }, () => ({
      label: msg`Confirm ETH payment`,
      description: msg`Confirm the ETH payment in your wallet. This transaction spends ETH and requires gas.`,
    }))
    .with({ action: 'paymentOrder' }, () => ({
      label: msg`Sign and submit payment order`,
      description: msg`Sign the CoW Swap order to exchange ${symbol} for the USDC needed for registration. Signing does not send a transaction. This step also waits for order submission.`,
    }))
    .exhaustive()
}
