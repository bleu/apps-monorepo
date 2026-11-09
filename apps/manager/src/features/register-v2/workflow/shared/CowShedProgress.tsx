import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Circle, CircleAlert, LoaderCircle } from 'lucide-react'
import { match } from 'ts-pattern'
import { cn } from '@/lib/utils'
import {
  type CowShedProgressProps,
  getCowShedProgressView,
} from './CowShedProgress.view'

export const CowShedProgress = (props: CowShedProgressProps) => {
  const { t, i18n } = useLingui()
  const view = getCowShedProgressView(props)

  return (
    <section className="min-w-0 space-y-3 rounded-lg border bg-white p-4 text-left text-sm">
      {props.machineState === 'runningCowShedRegistration' && (
        <p className="text-ens-gray">
          <Trans>Estimated time: about 1 min 30 sec</Trans>
        </p>
      )}
      <ol aria-label={t`Registration progress`} className="space-y-3">
        {view.milestones.map((step) => (
          <li
            aria-current={
              step.status === 'active' || step.status === 'stopped'
                ? 'step'
                : undefined
            }
            className="flex min-w-0 gap-3"
            key={step.label.id}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 shrink-0',
                step.status === 'stopped'
                  ? 'text-destructive'
                  : 'text-ens-gray',
              )}
            >
              {match(step.status)
                .with('completed', () => (
                  <Check className="size-4 text-ens-blue" />
                ))
                .with('active', () => (
                  <LoaderCircle className="size-4 motion-safe:animate-spin" />
                ))
                .with('stopped', () => <CircleAlert className="size-4" />)
                .with('pending', () => <Circle className="size-4" />)
                .exhaustive()}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ens-blue-dark">
                  {i18n._(step.label)}
                </span>
                <span className="text-ens-gray text-xs">
                  {match(step.status)
                    .with('completed', () => <Trans>Completed</Trans>)
                    .with('active', () => <Trans>In progress</Trans>)
                    .with('stopped', () => <Trans>Needs attention</Trans>)
                    .with('pending', () => <Trans>Pending</Trans>)
                    .exhaustive()}
                </span>
              </div>
              <p className="text-ens-gray">{i18n._(step.description)}</p>
              {step.href && step.linkLabel && (
                <a
                  className="rounded-sm text-ens-blue underline underline-offset-2 focus-visible:outline-2"
                  href={step.href}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {i18n._(step.linkLabel)}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
      {view.shedHref && (
        <p className="text-ens-gray">
          <Trans>
            This action uses a CoW Swap Account Proxy. If funds get stuck,
            recover them here:
          </Trans>{' '}
          <a
            className="rounded-sm underline underline-offset-2 focus-visible:outline-2"
            href={view.shedHref}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Trans>Recover funds in CoW Swap</Trans>
          </a>
        </p>
      )}
      {view.safetyMessage && (
        <p className="text-ens-gray">{i18n._(view.safetyMessage)}</p>
      )}
    </section>
  )
}
