export type WalletAction =
  | 'registrationHook'
  | 'setupHook'
  | 'tokenPermit'
  | 'resetAllowance'
  | 'tokenApproval'
  | 'nativePayment'
  | 'paymentOrder'

export type WalletProgress = Readonly<{
  action: WalletAction
  phase: 'awaitingSignature' | 'awaitingConfirmation' | 'completed'
}>

export type RegistrationWalletProgress = Readonly<{
  current?: WalletProgress
  completed: readonly WalletAction[]
}>

export const reduceWalletProgress = (
  previous: RegistrationWalletProgress | undefined,
  progress: WalletProgress,
): RegistrationWalletProgress => {
  const completed = previous?.completed ?? []
  const phase = progress.phase
  switch (phase) {
    case 'awaitingSignature':
      return {
        current: progress,
        completed: completed.filter((action) => action !== progress.action),
      }
    case 'awaitingConfirmation':
      return { current: progress, completed }
    case 'completed':
      return {
        current: undefined,
        completed: completed.includes(progress.action)
          ? completed
          : [...completed, progress.action],
      }
    default:
      return phase satisfies never
  }
}
