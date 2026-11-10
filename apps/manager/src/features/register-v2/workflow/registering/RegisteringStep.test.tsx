import '@testing-library/jest-dom'
import { registrationMachine } from '@ens-apps/transaction-manager'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { useRegistrationFillProgress } from '@/features/weave-registration/lib/useRegistrationFillProgress'
import { RegisterV2Context } from '../../state/registrationUi.context'
import { registrationV2UiMachine } from '../../state/registrationUi.machine'
import { makePlan } from '../shared/CowShedProgress.test-utils'
import { RegisteringStep } from './RegisteringStep'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useBlocker: () => undefined,
}))
vi.mock('./hooks/useRegistrationLockHeartbeat', () => ({
  useRegistrationLockHeartbeat: () => undefined,
}))
vi.mock('./hooks/useRegisteringCompletion', () => ({
  useRegisteringCompletion: () => ({ exitLoaderReady: false }),
}))
vi.mock('./components/CenteredWeaveLoader', () => ({
  CenteredWeaveLoader: () => null,
}))
vi.mock('./components/RegisteringHeader', () => ({
  RegisteringHeader: () => null,
}))
vi.mock('./components/NotificationSettings', () => ({
  NotificationSettings: () => null,
}))
vi.mock('./components/RegistrationDetails', () => ({
  RegistrationDetails: () => null,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
i18n.loadAndActivate({ locale: 'en', messages: {} })

const setupRegistration = (chainId: number) => {
  const uiActor = createActor(registrationV2UiMachine, { input: { chainId } })
  const registrationActor = createActor(registrationMachine, {
    input: { chainId },
  })
  const uiSnapshot = uiActor.getSnapshot()
  const txSnapshot = registrationActor.getSnapshot()
  const readUi = vi.spyOn(uiActor, 'getSnapshot')
  const readTx = vi.spyOn(registrationActor, 'getSnapshot')
  vi.spyOn(RegisterV2Context, 'use').mockReturnValue({
    uiActor,
    registrationActor,
    label: 'name-two',
    resume: { status: 'idle' },
  })
  return { uiSnapshot, txSnapshot, readUi, readTx }
}

const I18nWrapper = ({ children }: { readonly children: ReactNode }) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
)

const RegisteringProgress = () => {
  const progress = useRegistrationFillProgress(true, 0)
  return (
    <>
      <output aria-label="Fill progress">{progress.progress}</output>
      <RegisteringStep
        fillDone={progress.fillDone}
        fillProgress={progress.progress}
        isRegistrationComplete={progress.isRegistrationComplete}
      />
    </>
  )
}

describe('RegisteringStep', () => {
  it('paces the route fill from the live CoW stage', async () => {
    vi.useFakeTimers()
    const plan = await makePlan()
    const { uiSnapshot, txSnapshot, readUi, readTx } =
      setupRegistration(11155111)
    readUi.mockReturnValue({
      ...uiSnapshot,
      value: {
        registering: {
          notifications: 'completed',
          transaction: 'pendingRegistration',
        },
      },
      context: {
        ...uiSnapshot.context,
        maxProgressReached: {
          stage: 'runningCowShedRegistration',
          progress: 50,
        },
      },
    })
    readTx.mockReturnValue({
      ...txSnapshot,
      value: 'runningCowShedRegistration',
      context: {
        ...txSnapshot.context,
        cowShedRun: {
          stage: 'fundingSent',
          plan,
          funding: {
            kind: 'erc20',
            orderId: 'payment-order',
            validTo: 1_800_000_000,
          },
        },
      },
    })
    const view = render(<RegisteringProgress />, { wrapper: I18nWrapper })
    await act(() => vi.advanceTimersByTimeAsync(90_000))

    expect(Number(screen.getByLabelText('Fill progress').textContent)).toBe(30)
    expect(screen.getByText('Estimated time: about 1 min 30 sec')).toBeVisible()

    readTx.mockReturnValue({
      ...txSnapshot,
      value: 'success',
      context: {
        ...txSnapshot.context,
        cowShedRun: { stage: 'settled', plan },
      },
    })
    view.rerender(<RegisteringProgress />)
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(
      Number(screen.getByLabelText('Fill progress').textContent),
    ).toBeLessThan(100)
    expect(
      screen.queryByText('Estimated time: about 1 min 30 sec'),
    ).not.toBeInTheDocument()

    readUi.mockReturnValue({ ...uiSnapshot, value: 'success' })
    view.rerender(<RegisteringProgress />)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(Number(screen.getByLabelText('Fill progress').textContent)).toBe(100)
  })

  it.each(['settings', 'completed'] as const)(
    'shows the Account Proxy link when notifications are %s',
    async (notifications) => {
      const plan = await makePlan()
      const { uiSnapshot, txSnapshot, readUi, readTx } = setupRegistration(1)
      readUi.mockReturnValue({
        ...uiSnapshot,
        value: {
          registering: { notifications, transaction: 'pendingRegistration' },
        },
      })
      readTx.mockReturnValue({
        ...txSnapshot,
        value: 'runningCowShedRegistration',
        context: {
          ...txSnapshot.context,
          cowShedRun: { stage: 'revealSent', plan, orderId: 'live-order' },
        },
      })
      render(
        <RegisteringStep
          fillDone={false}
          fillProgress={60}
          isRegistrationComplete={false}
        />,
        { wrapper: I18nWrapper },
      )
      expect(
        screen.queryByRole('list', { name: 'Registration progress' }),
      ).not.toBeInTheDocument()
      const recoveryLink = screen.getByRole('link', {
        name: 'Recover funds in CoW Swap',
      })
      expect(recoveryLink).toHaveAttribute(
        'href',
        `https://swap.cow.fi/#/11155111/account-proxy/${plan.signed.cowShedAccount}`,
      )
      expect(recoveryLink).toHaveAttribute('target', '_blank')
      expect(recoveryLink).toHaveAttribute('rel', 'noopener noreferrer')
      expect(
        screen.queryByRole('link', { name: 'View registration order' }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/Do not add funds/)).not.toBeInTheDocument()
    },
  )
})
