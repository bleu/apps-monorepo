import { describe, expect, it } from 'vitest'
import { REGISTRATION_STAGE_PROGRESS } from '@/features/register-v2/state/registration.stages'
import {
  advanceForwardProgress,
  type ForwardProgressInputs,
} from './forwardProgressMath'

const makeInputs = (
  overrides: Partial<ForwardProgressInputs> = {},
): ForwardProgressInputs => ({
  stageProgress: REGISTRATION_STAGE_PROGRESS.commitmentCooldown,
  isComplete: false,
  nameLength: 8,
  cooldownRemainingSeconds: null,
  ...overrides,
})

describe('advanceForwardProgress', () => {
  it('keeps a long CoW payment wait in the payment range', () => {
    const progress = advanceForwardProgress(
      makeInputs({
        stageProgress: REGISTRATION_STAGE_PROGRESS.runningCowShedRegistration,
        cowShedStage: 'fundingSent',
      }),
      0,
      300,
    )

    expect(progress).toBe(30)
  })

  it('does not use the ordinary cooldown clock for a hidden CoW commitment wait', () => {
    const progress = advanceForwardProgress(
      makeInputs({ cowShedStage: 'funded', cooldownRemainingSeconds: 10 }),
      30,
      300,
    )

    expect(progress).toBe(70)
  })

  it('keeps restored progress when the saved CoW stage is older', () => {
    const progress = advanceForwardProgress(
      makeInputs({ cowShedStage: 'fundingSent' }),
      65,
      1,
    )

    expect(progress).toBe(65)
  })

  it('reserves the final fill for parent setup and success after CoW settlement', () => {
    const settled = makeInputs({ cowShedStage: 'settled' })
    const unverified = advanceForwardProgress(settled, 80, 300)
    const setup = advanceForwardProgress(
      {
        ...settled,
        stageProgress: REGISTRATION_STAGE_PROGRESS.settingPrimaryName,
      },
      unverified,
      300,
    )

    expect(unverified).toBe(96)
    expect(setup).toBeGreaterThan(unverified)
    expect(setup).toBeLessThan(100)
    expect(
      advanceForwardProgress({ ...settled, isComplete: true }, setup, 0.1),
    ).toBe(100)
  })

  it('fills a cooldown hidden in another tab as far as visible frames would have', () => {
    const start = 20
    const frameSeconds = 0.1
    const frameCount = 300
    const visible = Array.from(
      { length: frameCount },
      (_, i) => 60 - (i + 1) * frameSeconds,
    ).reduce(
      (current, remaining) =>
        advanceForwardProgress(
          makeInputs({ cooldownRemainingSeconds: remaining }),
          current,
          frameSeconds,
        ),
      start,
    )

    const hidden = advanceForwardProgress(
      makeInputs({ cooldownRemainingSeconds: 30 }),
      start,
      frameCount * frameSeconds,
    )

    // Half the cooldown has passed, so the fill is halfway from 20 to 80.
    expect(hidden).toBeCloseTo(50, 6)
    expect(visible).toBeCloseTo(hidden, 6)
  })

  it('plays the completion sweep after a hidden tab instead of jumping to full', () => {
    const progress = advanceForwardProgress(
      makeInputs({ isComplete: true }),
      40,
      30,
    )

    // 120%/s over one capped 0.1s frame.
    expect(progress).toBeCloseTo(52, 6)
  })
})
