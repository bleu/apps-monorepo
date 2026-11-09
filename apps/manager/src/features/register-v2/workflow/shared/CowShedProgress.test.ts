import type { CowShedProgress } from '@ens-apps/transaction-manager'
import { zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'
import { makePlan } from './CowShedProgress.test-utils'
import {
  getCowOrderExplorerUrl,
  getCowShedProgressView,
} from './CowShedProgress.view'

const plan = await makePlan()
const { authorization } = plan
const funding = {
  orderId: 'payment-order',
  validTo: 1_800_000_000,
  kind: 'erc20',
} as const

const stages: readonly CowShedProgress[] = [
  { stage: 'prepared', plan },
  { stage: 'fundingSubmission', plan },
  { stage: 'fundingSent', plan, funding },
  { stage: 'funded', plan },
  {
    stage: 'publishing',
    plan,
    orderId: zeroHash,
    request: {
      from: authorization.wallet,
      sellToken: authorization.wallet,
      buyToken: authorization.resolver,
      receiver: authorization.wallet,
      sellAmount: '1',
      buyAmount: '1',
      validTo: funding.validTo,
      appData: zeroHash,
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip1271',
      signature: '0x',
    } as Extract<CowShedProgress, { stage: 'publishing' }>['request'],
  },
  { stage: 'revealSent', plan, orderId: 'registration-order' },
  { stage: 'settled', plan, orderId: 'registration-order' },
]

describe('getCowShedProgressView', () => {
  it.each(stages.map((progress, index) => ({ progress, index })))(
    'shows the milestones for $progress.stage without claiming registration success',
    ({ progress, index }) => {
      const activeIndex = [0, 0, 0, 1, 2, 2, 3][index]
      const view = getCowShedProgressView({
        progress,
        machineState: 'runningCowShedRegistration',
      })
      expect(view.milestones.map(({ status }) => status)).toEqual(
        [0, 1, 2, 3].map((step) =>
          step < (activeIndex ?? 0)
            ? 'completed'
            : step === activeIndex
              ? 'active'
              : 'pending',
        ),
      )
    },
  )

  it.each(stages)('keeps confirmed history when $stage stops', (progress) => {
    const running = getCowShedProgressView({
      progress,
      machineState: 'runningCowShedRegistration',
    })
    const failed = getCowShedProgressView({ progress, machineState: 'error' })
    expect(failed.milestones.map(({ status }) => status)).toEqual(
      running.milestones.map(({ status }) =>
        status === 'active' ? 'stopped' : status,
      ),
    )
  })

  it('completes confirmation only after machine success', () => {
    const progress = { stage: 'settled', plan } as const
    expect(
      getCowShedProgressView({
        progress,
        machineState: 'verifyingRegistration',
      }).milestones[3]?.status,
    ).toBe('active')
    expect(
      getCowShedProgressView({
        progress,
        machineState: 'success',
      }).milestones.map(({ status }) => status),
    ).toEqual(['completed', 'completed', 'completed', 'completed'])
  })

  it('distinguishes an unsubmitted payment from an ambiguous submission', () => {
    const prepared = getCowShedProgressView({
      progress: { stage: 'prepared', plan },
      machineState: 'error',
    })
    const ambiguous = getCowShedProgressView({
      progress: { stage: 'fundingSubmission', plan },
      machineState: 'error',
    })
    expect(prepared.safetyMessage?.message).toContain(
      'No payment was submitted',
    )
    expect(ambiguous.safetyMessage?.message).toContain(
      'Payment submission is uncertain',
    )
    expect(
      getCowShedProgressView({
        progress: { stage: 'prepared', plan },
        machineState: 'runningCowShedRegistration',
      }).safetyMessage,
    ).toBeUndefined()
  })

  it('does not describe publication preparation as accepted', () => {
    const publishing = stages.find(({ stage }) => stage === 'publishing')
    if (!publishing) throw new Error('Missing publishing fixture')
    const view = getCowShedProgressView({
      progress: publishing,
      machineState: 'error',
    })
    expect(view.milestones[2]?.description.message).toContain(
      'not confirmed as accepted',
    )
    expect(view.milestones[2]?.href).toContain(zeroHash)
  })

  it('keeps missing order references absent and uses the saved chain for links', () => {
    const empty = getCowShedProgressView({
      progress: { stage: 'settled', plan },
      machineState: 'error',
    })
    expect(empty.milestones.map(({ href }) => href)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    const linked = getCowShedProgressView({
      progress: { stage: 'fundingSent', plan, funding },
      machineState: 'error',
    })
    expect(linked.milestones[0]?.href).toBe(
      'https://dev.explorer.cow.fi/sepolia/orders/payment-order?tab=overview',
    )
    expect(linked.shedHref).toBe(
      `https://swap.cow.fi/#/11155111/account-proxy/${plan.signed.cowShedAccount}`,
    )
  })
})

describe('getCowOrderExplorerUrl', () => {
  it.each([
    [
      11155111,
      'https://dev.explorer.cow.fi/sepolia/orders/order-id?tab=overview',
    ],
    [1, 'https://explorer.cow.fi/mainnet/orders/order-id?tab=overview'],
    [999999, undefined],
  ] as const)('links only supported chain %s', (chainId, expected) => {
    expect(getCowOrderExplorerUrl(chainId, 'order-id')).toBe(expected)
  })
})
