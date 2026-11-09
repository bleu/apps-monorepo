import '@testing-library/jest-dom'
import {
  type CowShedProgress,
  registrationMachine,
} from '@ens-apps/transaction-manager'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { RegisterV2Context } from '../../state/registrationUi.context'
import { registrationV2UiMachine } from '../../state/registrationUi.machine'
import { makePlan } from '../shared/CowShedProgress.test-utils'
import { FailureStep, FailureStepView } from './FailureStep'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

i18n.loadAndActivate({ locale: 'en', messages: {} })

const renderView = (
  props: Partial<Parameters<typeof FailureStepView>[0]> = {},
) =>
  render(
    <I18nProvider i18n={i18n}>
      <FailureStepView
        label="name-two"
        message="Something went wrong."
        onCancel={vi.fn()}
        onFindAnotherName={vi.fn()}
        onRetry={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  )

const renderFailure = ({
  live,
  restored,
  retry = vi.fn(),
}: {
  readonly live?: CowShedProgress
  readonly restored?: CowShedProgress
  readonly retry?: () => void
}) => {
  const uiActor = createActor(registrationV2UiMachine, {
    input: { chainId: 11155111 },
  })
  const send = vi.spyOn(uiActor, 'send')
  const uiSnapshot = uiActor.getSnapshot()
  const txSnapshot = createActor(registrationMachine, {
    input: { chainId: 11155111 },
  }).getSnapshot()
  vi.spyOn(RegisterV2Context, 'use').mockReturnValue({
    uiActor,
    registrationActor: undefined,
    label: 'name-two',
    resume: { status: 'failed', retry },
  })
  vi.spyOn(RegisterV2Context, 'useSelector').mockImplementation((selector) =>
    selector({
      ...uiSnapshot,
      context: {
        ...uiSnapshot.context,
        restoredRun: restored
          ? { label: 'name-two', updatedAt: 1, cowShedRun: restored }
          : undefined,
      },
    }),
  )
  vi.spyOn(RegisterV2Context, 'useTxSelector').mockImplementation((selector) =>
    selector({
      ...txSnapshot,
      context: { ...txSnapshot.context, cowShedRun: live },
    }),
  )
  render(
    <I18nProvider i18n={i18n}>
      <FailureStep />
    </I18nProvider>,
  )
  return { send }
}

describe('FailureStep', () => {
  it.each(['live', 'restored'] as const)(
    'keeps a %s prepared run on the normal Back to Quote path',
    async (source) => {
      const plan = await makePlan()
      const { send } = renderFailure({
        [source]: { stage: 'prepared', plan },
      })

      expect(
        screen.getByRole('list', { name: 'Registration progress' }),
      ).toBeVisible()
      expect(screen.queryByText(/Shed address:/)).not.toBeInTheDocument()
      expect(screen.getByText(/No payment was submitted/)).toHaveTextContent(
        /Signed hooks may still execute/,
      )
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Back to Quote' }))
      expect(send).toHaveBeenCalledWith({ type: 'cancel' })
    },
  )

  it.each([
    { source: 'live', stage: 'fundingSubmission' },
    { source: 'restored', stage: 'fundingSubmission' },
    { source: 'live', stage: 'funded' },
    { source: 'restored', stage: 'settled' },
  ] as const)(
    'keeps progress for a $source $stage run without an order UID',
    async ({ source, stage }) => {
      const plan = await makePlan()
      const { send } = renderFailure({ [source]: { stage, plan } })

      expect(
        screen.getByRole('list', { name: 'Registration progress' }),
      ).toHaveTextContent('Needs attention')
      expect(
        screen.getByRole('link', { name: 'Recover funds in CoW Swap' }),
      ).toHaveAttribute(
        'href',
        `https://swap.cow.fi/#/11155111/account-proxy/${plan.signed.cowShedAccount}`,
      )
      expect(
        screen.getByText(/Signed orders or hooks may still execute/),
      ).toBeVisible()
      expect(
        screen.queryByText(/No payment was submitted/),
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/Funding order:/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Back to Quote' }))
      expect(send).toHaveBeenCalledWith({ type: 'cancel' })
    },
  )

  it('uses live progress instead of an older restored run', async () => {
    const plan = await makePlan()
    renderFailure({
      live: { stage: 'fundingSubmission', plan },
      restored: { stage: 'prepared', plan },
    })

    expect(screen.getByText(/Payment submission is uncertain/)).toBeVisible()
    expect(
      screen.queryByText(/No payment was submitted/),
    ).not.toBeInTheDocument()
  })
})

describe('FailureStepView', () => {
  // The refusal used to read as a failed registration, with Try Again as the
  // main action, when nothing had run and the fix is in the other tab.
  it('presents a wallet held elsewhere as a wait, not a failure', async () => {
    const plan = await makePlan()
    renderView({
      message: 'name-one.eth is already being registered with this wallet.',
      isWalletBusy: true,
      cowShedProgress: { stage: 'prepared', plan },
    })

    expect(
      screen.queryByRole('list', { name: 'Registration progress' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Another Registration Is Running')).toBeVisible()
    expect(screen.queryByText('Registration Failed')).not.toBeInTheDocument()
    expect(
      screen.getByText(/finish or cancel the other registration/i),
    ).toBeVisible()
    // Back to Quote leads; Try Again stays for when the other run is done.
    expect(screen.getByRole('button', { name: 'Back to Quote' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeVisible()
  })

  it('explains a lost race instead of showing the raw error', () => {
    const onFindAnotherName = vi.fn()
    renderView({
      onFindAnotherName,
      message:
        'The contract function "getRegisterPrice" reverted with the following signature: 0x477707e8',
      nameUnavailable: true,
    })

    expect(screen.getByText('Name No Longer Available')).toBeVisible()
    expect(
      screen.getByText(
        'name-two.eth was registered by someone else just before your registration went through.',
      ),
    ).toBeVisible()
    expect(screen.queryByText(/getRegisterPrice/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Try Again' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Back to Quote' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Look for a different name' }),
    )
    expect(onFindAnotherName).toHaveBeenCalledOnce()
  })

  it('keeps linked Shed and order references after a lost name', async () => {
    const plan = await makePlan()
    renderView({
      nameUnavailable: true,
      cowShedProgress: {
        stage: 'settled',
        plan: {
          ...plan,
          funding: {
            kind: 'erc20',
            orderId: 'first-order',
            validTo: 1_800_000_000,
          },
        },
        orderId: 'second-order',
      },
    })
    expect(
      screen.getByRole('link', { name: 'Recover funds in CoW Swap' }),
    ).toHaveAttribute(
      'href',
      `https://swap.cow.fi/#/11155111/account-proxy/${plan.signed.cowShedAccount}`,
    )
    expect(
      screen.getByRole('link', { name: 'View payment order' }),
    ).toHaveAttribute(
      'href',
      'https://dev.explorer.cow.fi/sepolia/orders/first-order?tab=overview',
    )
    expect(
      screen.getByRole('link', { name: 'View registration order' }),
    ).toHaveAttribute(
      'href',
      'https://dev.explorer.cow.fi/sepolia/orders/second-order?tab=overview',
    )
    expect(
      screen.queryByText(/Shed address:|Funding order:|Registration order:/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Signed orders or hooks may still execute/),
    ).toBeVisible()
  })

  it('shows restored settlement as a confirmation failure and preserves resume retry', async () => {
    const plan = await makePlan()
    const retry = vi.fn()
    const { send } = renderFailure({
      restored: { stage: 'settled', plan, orderId: 'settled-order' },
      retry,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith({ type: 'retry' })
    expect(screen.getByText('Registration confirmation failed')).toBeVisible()
    expect(screen.getAllByText('Completed')).toHaveLength(3)
    expect(screen.getByText('Needs attention')).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'View registration order' }),
    ).toHaveAttribute(
      'href',
      'https://dev.explorer.cow.fi/sepolia/orders/settled-order?tab=overview',
    )
  })

  it('still reports a real failure as one', () => {
    renderView()

    expect(
      screen.queryByRole('list', { name: 'Registration progress' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Registration Failed')).toBeVisible()
    expect(
      screen.getByText(/retrying will attempt the registration/i),
    ).toBeVisible()
  })
})
