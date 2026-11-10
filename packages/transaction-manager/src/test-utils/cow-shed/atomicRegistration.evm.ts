import { expect, it } from 'vitest'
import { prepareCowShedRegistration } from '../../machines/registration/registration.cow-shed'
import {
  COW_SHED_LOCAL_EVM_INPUT,
  verifyCowShedRegistrationOnLocalEvm,
} from './localEvm'

it('executes generated registration hooks atomically on the pinned Sepolia Shed runtime', async () => {
  const { stdout } = await verifyCowShedRegistrationOnLocalEvm(
    prepareCowShedRegistration(COW_SHED_LOCAL_EVM_INPUT),
  )
  expect(stdout).toContain('9 passed; 0 failed')
}, 60_000)
