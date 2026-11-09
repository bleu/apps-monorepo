import '@testing-library/jest-dom'
import { registrationMachine } from '@ens-apps/transaction-manager'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, render, screen } from '@testing-library/react'
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
    const uiActor = createActor(registrationV2UiMachine, {
      input: { chainId: 11155111 },
    })
    const registrationActor = createActor(registrationMachine, {
      input: { chainId: 11155111 },
    })
    const uiSnapshot = uiActor.getSnapshot()
    const readUi = vi.spyOn(uiActor, 'getSnapshot').mockReturnValue({
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
    const txSnapshot = registrationActor.getSnapshot()
    const readTx = vi.spyOn(registrationActor, 'getSnapshot').mockReturnValue({
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
    vi.spyOn(RegisterV2Context, 'use').mockReturnValue({
      uiActor,
      registrationActor,
      label: 'name-two',
      resume: { status: 'idle' },
    })
    const view = render(
      <I18nProvider i18n={i18n}>
        <RegisteringProgress />
      </I18nProvider>,
    )
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
    view.rerender(
      <I18nProvider i18n={i18n}>
        <RegisteringProgress />
      </I18nProvider>,
    )
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(
      Number(screen.getByLabelText('Fill progress').textContent),
    ).toBeLessThan(100)
    expect(
      screen.queryByText('Estimated time: about 1 min 30 sec'),
    ).not.toBeInTheDocument()

    readUi.mockReturnValue({ ...uiSnapshot, value: 'success' })
    view.rerender(
      <I18nProvider i18n={i18n}>
        <RegisteringProgress />
      </I18nProvider>,
    )
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(Number(screen.getByLabelText('Fill progress').textContent)).toBe(100)
  })

  it.each(['settings', 'completed'] as const)(
    'shows linked live progress when notifications are %s',
    async (notifications) => {
      const plan = await makePlan()
      const uiActor = createActor(registrationV2UiMachine, {
        input: { chainId: 1 },
      })
      const registrationActor = createActor(registrationMachine, {
        input: { chainId: 1 },
      })
      const uiSnapshot = uiActor.getSnapshot()
      vi.spyOn(uiActor, 'getSnapshot').mockReturnValue({
        ...uiSnapshot,
        value: {
          registering: { notifications, transaction: 'pendingRegistration' },
        },
      })
      const txSnapshot = registrationActor.getSnapshot()
      vi.spyOn(registrationActor, 'getSnapshot').mockReturnValue({
        ...txSnapshot,
        value: 'runningCowShedRegistration',
        context: {
          ...txSnapshot.context,
          cowShedRun: { stage: 'revealSent', plan, orderId: 'live-order' },
        },
      })
      vi.spyOn(RegisterV2Context, 'use').mockReturnValue({
        uiActor,
        registrationActor,
        label: 'name-two',
        resume: { status: 'idle' },
      })
      render(
        <I18nProvider i18n={i18n}>
          <RegisteringStep
            fillDone={false}
            fillProgress={60}
            isRegistrationComplete={false}
          />
        </I18nProvider>,
      )
      expect(
        screen.getByRole('list', { name: 'Registration progress' }),
      ).toBeVisible()
      expect(
        screen.getByRole('link', { name: 'View registration order' }),
      ).toHaveAttribute(
        'href',
        'https://dev.explorer.cow.fi/sepolia/orders/live-order?tab=overview',
      )
      expect(screen.queryByText(/Do not add funds/)).not.toBeInTheDocument()
    },
  )
})
