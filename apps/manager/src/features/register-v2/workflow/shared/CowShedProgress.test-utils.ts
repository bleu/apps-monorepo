import { type CowShedProgress, NATIVE_ETH } from '@ens-apps/transaction-manager'
import { prepareCowShedQuoteHooks } from '@ens-apps/transaction-manager/machines/registration/registration.cow-shed'
import { zeroHash } from 'viem'

export const makePlan = async (): Promise<CowShedProgress['plan']> => {
  const authorization = {
    chainId: 11155111,
    wallet: '0x1111111111111111111111111111111111111111',
    resolver: '0x2222222222222222222222222222222222222222',
    name: 'name-two.eth',
    duration: 31_536_000n,
    secret: zeroHash,
    commitment: zeroHash,
    registrationPrice: 5_000_000n,
    executionBudget: 100_000n,
    firstOrderValidTo: 1_800_000_000n,
    secondOrderValidTo: 1_800_003_600n,
    salt: zeroHash,
    setupNonce: zeroHash,
    registrationNonce: zeroHash,
  } as const
  return {
    authorization,
    signed: await prepareCowShedQuoteHooks(authorization),
    sellToken: NATIVE_ETH,
    maximumSell: 10n ** 16n,
  }
}
