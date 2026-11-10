import type { CowShedProgress } from '@ens-apps/transaction-manager'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { match } from 'ts-pattern'
import { mainnet, sepolia } from 'viem/chains'

interface CowShedRecoveryLinkProps {
  readonly progress: CowShedProgress
  readonly isFailed?: boolean
}

function getRecoveryLink({ progress, isFailed }: CowShedRecoveryLinkProps): {
  readonly href: string | undefined
  readonly safetyMessage: MessageDescriptor | undefined
} {
  const chainId = progress.plan.authorization.chainId
  const isSupportedChain = chainId === mainnet.id || chainId === sepolia.id
  return {
    href: isSupportedChain
      ? `https://swap.cow.fi/#/${chainId}/account-proxy/${progress.plan.signed.cowShedAccount}`
      : undefined,
    safetyMessage: isFailed
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
      : undefined,
  }
}

export const CowShedRecoveryLink = (props: CowShedRecoveryLinkProps) => {
  const { i18n } = useLingui()
  const { href, safetyMessage } = getRecoveryLink(props)
  return (
    <div className="min-w-0 space-y-3 text-ens-gray text-sm">
      {href && (
        <p>
          <Trans>
            This action uses a CoW Swap Account Proxy. If funds get stuck,
            recover them here:
          </Trans>{' '}
          <a
            className="rounded-sm underline underline-offset-2 focus-visible:outline-2"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Trans>Recover funds in CoW Swap</Trans>
          </a>
        </p>
      )}
      {safetyMessage && <p>{i18n._(safetyMessage)}</p>}
    </div>
  )
}
