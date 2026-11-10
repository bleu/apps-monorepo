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
