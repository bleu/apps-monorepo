import { describe, expect, it } from 'vitest'
import { reduceWalletProgress } from './registration.wallet-progress'

describe('registration wallet progress', () => {
  it('keeps completed hooks while another action runs and ignores repeated completion', () => {
    const signed = reduceWalletProgress(undefined, {
      action: 'registrationHook',
      phase: 'completed',
    })
    const prompting = reduceWalletProgress(signed, {
      action: 'setupHook',
      phase: 'awaitingSignature',
    })
    expect(prompting).toEqual({
      current: { action: 'setupHook', phase: 'awaitingSignature' },
      completed: ['registrationHook'],
    })
    const completed = reduceWalletProgress(prompting, {
      action: 'setupHook',
      phase: 'completed',
    })
    expect(
      reduceWalletProgress(completed, {
        action: 'setupHook',
        phase: 'completed',
      }),
    ).toEqual({
      current: undefined,
      completed: ['registrationHook', 'setupHook'],
    })
  })

  it('withdraws completed approval evidence when a fresh approval is requested', () => {
    const completed = reduceWalletProgress(undefined, {
      action: 'tokenApproval',
      phase: 'completed',
    })
    expect(completed).toEqual({
      current: undefined,
      completed: ['tokenApproval'],
    })
    const repeated = reduceWalletProgress(completed, {
      action: 'tokenApproval',
      phase: 'awaitingSignature',
    })
    expect(repeated).toEqual({
      current: { action: 'tokenApproval', phase: 'awaitingSignature' },
      completed: [],
    })
    expect(
      reduceWalletProgress(repeated, {
        action: 'tokenApproval',
        phase: 'awaitingConfirmation',
      }),
    ).toEqual({
      current: { action: 'tokenApproval', phase: 'awaitingConfirmation' },
      completed: [],
    })
  })
})
