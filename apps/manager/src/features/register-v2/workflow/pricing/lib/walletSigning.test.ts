import { describe, expect, it } from 'vitest'
import { getWalletSigningView } from './walletSigning'

describe('getWalletSigningView', () => {
  it('uses saved hooks as completion evidence without inventing a token authorization', () => {
    const view = getWalletSigningView({
      token: { symbol: 'WETH', isNative: false },
      hasSignedHooks: true,
      progress: {
        completed: [],
        current: { action: 'paymentOrder', phase: 'awaitingSignature' },
      },
    })
    expect(
      view.steps.map(({ action, status }) => ({ action, status })),
    ).toEqual([
      { action: 'registrationHook', status: 'completed' },
      { action: 'setupHook', status: 'completed' },
      { action: 'paymentOrder', status: 'active' },
    ])
  })

  it('keeps a repeated approval active until its new receipt succeeds', () => {
    const view = getWalletSigningView({
      token: { symbol: 'USDT', isNative: false },
      progress: {
        completed: [
          'registrationHook',
          'setupHook',
          'resetAllowance',
          'tokenApproval',
        ],
        current: { action: 'tokenApproval', phase: 'awaitingConfirmation' },
      },
    })
    expect(
      view.steps.map(({ action, status }) => ({ action, status })),
    ).toEqual([
      { action: 'registrationHook', status: 'completed' },
      { action: 'setupHook', status: 'completed' },
      { action: 'resetAllowance', status: 'completed' },
      { action: 'tokenApproval', status: 'active' },
      { action: 'paymentOrder', status: 'pending' },
    ])
    expect(view.current?.label.message).toBe('Confirming {symbol} approval')
  })
})
