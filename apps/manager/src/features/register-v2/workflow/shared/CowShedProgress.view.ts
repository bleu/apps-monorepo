import type {
  CowShedProgress,
  registrationMachine,
} from '@ens-apps/transaction-manager'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { match, P } from 'ts-pattern'
import { mainnet, sepolia } from 'viem/chains'
import type { SnapshotFrom } from 'xstate'

export interface CowShedProgressProps {
  readonly progress: CowShedProgress
  readonly machineState: SnapshotFrom<typeof registrationMachine>['value']
}

type MilestoneStatus = 'pending' | 'active' | 'completed' | 'stopped'

interface Milestone {
  readonly label: MessageDescriptor
  readonly description: MessageDescriptor
  readonly status: MilestoneStatus
  readonly href?: string
  readonly linkLabel?: MessageDescriptor
}

interface CowShedProgressView {
  readonly milestones: readonly Milestone[]
  readonly safetyMessage?: MessageDescriptor
  readonly isConfirmationFailure: boolean
  readonly shedHref?: string
}

export function getCowOrderExplorerUrl(
  chainId: number,
  orderId: string,
): string | undefined {
  const base = match(chainId)
    .with(1, () => 'https://explorer.cow.fi/mainnet')
    .with(11155111, () => 'https://dev.explorer.cow.fi/sepolia')
    .otherwise(() => undefined)
  return base
    ? `${base}/orders/${encodeURIComponent(orderId)}?tab=overview`
    : undefined
}

export function getCowShedProgressView({
  progress,
  machineState,
}: CowShedProgressProps): CowShedProgressView {
  const isFailed = machineState === 'error'
  const isConfirmed = machineState === 'success'
  const current = match(progress.stage)
    .with('prepared', () => ({
      index: 0,
      description: msg`Preparing payment and requesting wallet approval.`,
    }))
    .with('fundingSubmission', () => ({
      index: 0,
      description: msg`Submitting payment. Acceptance is not yet confirmed.`,
    }))
    .with('fundingSent', () => ({
      index: 0,
      description: msg`Payment submitted. Waiting for settlement.`,
    }))
    .with('funded', () => ({
      index: 1,
      description: msg`Payment settled. Waiting for the commitment to be ready.`,
    }))
    .with('publishing', () => ({
      index: 2,
      description: msg`Publishing the registration order; not confirmed as accepted.`,
    }))
    .with('revealSent', () => ({
      index: 2,
      description: msg`Registration order submitted. Waiting for settlement.`,
    }))
    .with('settled', () => ({
      index: 3,
      description: msg`Order settled. Checking registration on-chain.`,
    }))
    .exhaustive()
  const chainId = progress.plan.authorization.chainId
  const fundingOrderId =
    progress.plan.funding?.orderId ??
    ('funding' in progress ? progress.funding.orderId : undefined)
  const orderId = 'orderId' in progress ? progress.orderId : undefined
  const steps = [
    {
      label: msg`Payment`,
      description: msg`Payment settled.`,
      href: fundingOrderId
        ? getCowOrderExplorerUrl(chainId, fundingOrderId)
        : undefined,
      linkLabel: msg`View payment order`,
    },
    {
      label: msg`Commitment wait`,
      description: msg`Commitment wait complete.`,
    },
    {
      label: msg`Registration order`,
      description: msg`Registration order settled.`,
      href: orderId ? getCowOrderExplorerUrl(chainId, orderId) : undefined,
      linkLabel: msg`View registration order`,
    },
    {
      label: msg`Registration confirmation`,
      description: msg`Registration confirmed on-chain.`,
    },
  ] as const
  const milestones: readonly Milestone[] = steps.map((step, index) => {
    const status = match({ isConfirmed, index })
      .with({ isConfirmed: true }, () => 'completed' as const)
      .with(
        { index: P.when((value) => value < current.index) },
        () => 'completed' as const,
      )
      .with({ index: current.index }, () =>
        isFailed ? ('stopped' as const) : ('active' as const),
      )
      .otherwise(() => 'pending' as const)
    const description = match(status)
      .with('completed', () => step.description)
      .with('pending', () => msg`Not started.`)
      .otherwise(() => current.description)
    return { ...step, status, description }
  })
  const safetyMessage = isFailed
    ? match(progress.stage)
        .with(
          'prepared',
          () =>
            msg`No payment was submitted. Signed hooks may still execute. Going back does not cancel them. Do not add funds to the Shed.`,
        )
        .with(
          'fundingSubmission',
          () =>
            msg`Payment submission is uncertain. Signed orders or hooks may still execute. Going back does not cancel them. Do not add funds to the Shed.`,
        )
        .otherwise(
          () =>
            msg`Signed orders or hooks may still execute. Going back does not cancel them. Do not add funds to the Shed.`,
        )
    : undefined
  const chain = [mainnet, sepolia].find(({ id }) => id === chainId)
  return {
    milestones,
    safetyMessage,
    isConfirmationFailure: isFailed && progress.stage === 'settled',
    shedHref: chain
      ? `https://swap.cow.fi/#/${chainId}/account-proxy/${progress.plan.signed.cowShedAccount}`
      : undefined,
  }
}
