import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Circle, LoaderCircle } from 'lucide-react'
import { match } from 'ts-pattern'
import type { WalletSigningView } from '../lib/walletSigning'

export const WalletSigningProgress = ({
  view,
}: {
  readonly view: WalletSigningView
}) => {
  const { t } = useLingui()
  return (
    <section className="space-y-2 px-1">
      <ol aria-label={t`Wallet signing progress`} className="space-y-1 text-xs">
        {view.steps.map((step) => (
          <li
            aria-current={step.status === 'active' ? 'step' : undefined}
            className="flex items-center gap-2"
            key={step.action}
          >
            {match(step.status)
              .with('completed', () => (
                <Check aria-hidden className="size-3 shrink-0" />
              ))
              .with('active', () => (
                <LoaderCircle
                  aria-hidden
                  className="size-3 shrink-0 animate-spin"
                />
              ))
              .with('pending', () => (
                <Circle aria-hidden className="size-3 shrink-0" />
              ))
              .exhaustive()}
            <span className="flex-1">{t(step.label)}</span>
            <span className="text-ens-quartz-500">
              {match(step.status)
                .with('completed', () => <Trans>Completed</Trans>)
                .with('active', () => <Trans>In progress</Trans>)
                .with('pending', () => <Trans>Pending</Trans>)
                .exhaustive()}
            </span>
          </li>
        ))}
      </ol>
      {view.current && (
        <p aria-live="polite" className="text-ens-quartz-500 text-xs">
          {t(view.current.description)}
        </p>
      )}
    </section>
  )
}
