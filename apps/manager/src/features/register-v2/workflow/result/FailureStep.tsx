import type { CowShedProgress } from '@ens-apps/transaction-manager'
import { Trans, useLingui } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { Clock } from 'lucide-react'
import { match, P } from 'ts-pattern'
import { DomainCard } from '@/components/atoms/DomainCard/DomainCard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RegisterV2Context } from '../../state/registrationUi.context'

import { CowShedProgress as CowShedProgressTracker } from '../shared/CowShedProgress'
import { getCowShedProgressView } from '../shared/CowShedProgress.view'

export const FailureStep = () => {
  const { uiActor, label, resume } = RegisterV2Context.use()
  const liveCowShedRun = RegisterV2Context.useTxSelector(
    (state) => state?.context.cowShedRun,
  )
  const restoredCowShedRun = RegisterV2Context.useSelector(
    (state) => state.context.restoredRun?.cowShedRun,
  )
  const isRecoveryOnly = RegisterV2Context.useSelector(
    (state) => state.context.restoredRun?.recoveryReason !== undefined,
  )
  const cowShedProgress = liveCowShedRun ?? restoredCowShedRun
  const navigate = useNavigate()
  const message = RegisterV2Context.useSelector(
    (state) => state.context.lastErrorMessage,
  )
  // Someone else registered the name first. Retrying can only fail the same
  // way, so the only way out is back to the quote with a different name.
  const nameUnavailable = RegisterV2Context.useSelector(
    (state) => state.context.nameUnavailable,
  )
  // Another tab is registering with this wallet. Nothing started here, so the
  // screen waits on that run rather than offering to retry this one.
  const isWalletBusy = RegisterV2Context.useSelector(
    (state) => state.context.isWalletBusy,
  )
  // A run that failed before this page loaded. Its machine never resumed, so
  // Try Again resumes it rather than retrying it.
  const isRestoredFailure = RegisterV2Context.useSelector(
    (state) => state.context.restoredRun !== undefined,
  )

  const onRetry = () => {
    if (!isRestoredFailure) {
      uiActor.send({ type: 'retry' })
      return
    }
    if (resume.status === 'failed') resume.retry()
  }

  return (
    <FailureStepView
      cowShedProgress={cowShedProgress}
      isRecoveryOnly={isRecoveryOnly}
      isWalletBusy={isWalletBusy}
      label={label}
      message={message}
      nameUnavailable={nameUnavailable}
      onCancel={() => uiActor.send({ type: 'cancel' })}
      onFindAnotherName={() => {
        uiActor.send({ type: 'cancel' })
        navigate({ to: '/', search: { landing: true } })
      }}
      onRetry={onRetry}
    />
  )
}

interface FailureStepViewProps {
  readonly label: string
  readonly cowShedProgress?: CowShedProgress
  readonly isRecoveryOnly?: boolean
  readonly message?: string
  readonly nameUnavailable?: boolean
  /** This run was refused because the wallet is busy, rather than failing. */
  readonly isWalletBusy?: boolean
  readonly onRetry: () => void
  readonly onCancel: () => void
  /** The name is gone, so send them to search for another one. */
  readonly onFindAnotherName: () => void
}

export const FailureStepView = ({
  label,
  message,
  nameUnavailable,
  isWalletBusy = false,
  isRecoveryOnly = false,
  cowShedProgress,
  onRetry,
  onCancel,
  onFindAnotherName,
}: FailureStepViewProps) => {
  const { t } = useLingui()
  const progress = isWalletBusy ? undefined : cowShedProgress
  const isConfirmationFailure = progress
    ? getCowShedProgressView({ progress, machineState: 'error' })
        .isConfirmationFailure
    : false

  return (
    <div className="mx-auto mt-12 mb-4 w-full-[32px] max-w-6xl space-y-6.5">
      <Alert
        icon={isWalletBusy ? <Clock className="size-4" /> : undefined}
        variant="destructive"
      >
        <AlertTitle>
          {match({
            nameUnavailable,
            isWalletBusy,
            isConfirmationFailure,
            isRecoveryOnly,
          })
            .with({ nameUnavailable: true }, () => (
              <Trans>Name No Longer Available</Trans>
            ))
            .with({ isWalletBusy: true }, () => (
              <Trans>Another Registration Is Running</Trans>
            ))
            .with({ isRecoveryOnly: true }, () => (
              <Trans>Registration authorization expired</Trans>
            ))
            .with({ isConfirmationFailure: true }, () => (
              <Trans>Registration confirmation failed</Trans>
            ))
            .otherwise(() => (
              <Trans>Registration Failed</Trans>
            ))}
        </AlertTitle>
        <AlertDescription className="max-h-32 overflow-y-auto">
          {match({
            nameUnavailable,
            message,
            progress,
            isConfirmationFailure,
            isRecoveryOnly,
          })
            .with(
              { nameUnavailable: true },
              () =>
                t`${label}.eth was registered by someone else just before your registration went through.`,
            )
            .with(
              { isRecoveryOnly: true },
              () =>
                t`This commitment expired. This attempt cannot continue. Use CoW Swap to recover any remaining funds.`,
            )
            .with(
              { isConfirmationFailure: true },
              () =>
                t`The order settled, but registration could not be confirmed. Try Again will check registration without making a new payment.`,
            )
            .with(
              { progress: P.not(P.nullish) },
              () =>
                t`Registration stopped at the step shown below. Try Again will continue from the saved progress.`,
            )
            .with({ message: P.string.minLength(1) }, ({ message }) => message)
            .otherwise(
              () =>
                t`The registration for ${label}.eth could not be completed. You can retry or go back to adjust your settings.`,
            )}
        </AlertDescription>
      </Alert>

      {progress && (
        <CowShedProgressTracker machineState="error" progress={progress} />
      )}
      {progress && message && !nameUnavailable && (
        <details className="min-w-0 text-ens-gray text-sm">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2">
            <Trans>Error details</Trans>
          </summary>
          <p className="wrap-anywhere mt-2 max-h-32 overflow-y-auto">
            {message}
          </p>
        </details>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-16">
        <div className="w-full lg:w-1/2">
          <DomainCard domainName={`${label}.eth`} variant="lapis" />
        </div>

        <div className="flex w-full flex-col gap-6 lg:w-1/2">
          <div className="flex flex-col gap-1.5">
            <h3 className="font-medium text-ens-blue-dark text-xl tracking-tight">
              <Trans>What would you like to do?</Trans>
            </h3>
            <p className="text-ens-gray text-sm">
              {match({ nameUnavailable, isWalletBusy, isRecoveryOnly })
                .with({ nameUnavailable: true }, () => (
                  <Trans>
                    Another address registered this name first, so it can no
                    longer be registered here. Look for a different name.
                  </Trans>
                ))
                .with({ isRecoveryOnly: true }, () => (
                  <Trans>
                    Recover any remaining funds before starting another
                    registration.
                  </Trans>
                ))
                .with({ isWalletBusy: true }, () => (
                  <Trans>
                    Finish or cancel the other registration in its tab, then Try
                    Again once this wallet is free.
                  </Trans>
                ))
                .otherwise(() => (
                  <Trans>
                    Retrying will attempt the registration again from where it
                    left off.
                  </Trans>
                ))}
            </p>
          </div>

          <div className="flex gap-3">
            {!nameUnavailable && !isRecoveryOnly && (
              <Button
                className="flex-1"
                onClick={onRetry}
                size="xl"
                type="button"
                variant={isWalletBusy ? 'lightBlue' : 'blue'}
              >
                <Trans>Try Again</Trans>
              </Button>
            )}
            {nameUnavailable ? (
              <Button
                className="flex-1"
                onClick={onFindAnotherName}
                size="xl"
                type="button"
                variant="blue"
              >
                <Trans>Look for a different name</Trans>
              </Button>
            ) : (
              <Button
                className="flex-1"
                onClick={onCancel}
                size="xl"
                type="button"
                variant={isWalletBusy ? 'blue' : 'lightBlue'}
              >
                <Trans>Back to Quote</Trans>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
