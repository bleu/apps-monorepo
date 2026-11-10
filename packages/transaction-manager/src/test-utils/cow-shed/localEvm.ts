import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  encodeAbiParameters,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
} from 'viem'
import {
  getCowShedAddress,
  type prepareCowShedRegistration,
} from '../../machines/registration/registration.cow-shed'

const execFileAsync = promisify(execFile)
const CALLS_ABI = parseAbiParameters(
  '(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)[]',
)

export const COW_SHED_LOCAL_EVM_INPUT = {
  chainId: 11155111,
  wallet: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  resolver: zeroAddress,
  name: 'local-atomic-registration.eth',
  duration: 31_536_000n,
  secret: `0x${'11'.repeat(32)}`,
  commitment: `0x${'22'.repeat(32)}`,
  registrationPrice: 5_000_000n,
  executionBudget: 1_000_000n,
  firstOrderValidTo: 1_800_000_600n,
  secondOrderValidTo: 1_800_007_200n,
  appDataHash: zeroHash,
  salt: zeroHash,
} as const satisfies Parameters<typeof prepareCowShedRegistration>[0]

/**
 * Run from transaction-manager with Forge and solc 0.8.25 installed:
 * pnpm exec vitest run --config src/test-utils/cow-shed/vitest.evm.config.ts
 * Runtime provenance is in sepolia-runtime.json. Execution is offline and uses only a local test key.
 */
export const verifyCowShedRegistrationOnLocalEvm = async (
  prepared: ReturnType<typeof prepareCowShedRegistration>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'ens-cow-shed-evm-'))
  const fixtures = fileURLToPath(new URL('.', import.meta.url))
  try {
    await Promise.all([
      copyFile(
        join(fixtures, 'AtomicRegistration.t.sol'),
        join(root, 'AtomicRegistration.t.sol'),
      ),
      copyFile(
        join(fixtures, 'sepolia-runtime.json'),
        join(root, 'runtime.json'),
      ),
      writeFile(
        join(root, 'foundry.toml'),
        '[profile.default]\nsrc = "src"\ntest = "."\nsolc_version = "0.8.25"\nevm_version = "cancun"\noffline = true\nfs_permissions = [{ access = "read", path = "./" }]\n',
      ),
      writeFile(
        join(root, 'calls.json'),
        JSON.stringify({
          setup: encodeAbiParameters(CALLS_ABI, [prepared.setupCalls]),
          registration: encodeAbiParameters(CALLS_ABI, [
            prepared.registrationCalls,
          ]),
          proxy: encodeAbiParameters(parseAbiParameters('address'), [
            getCowShedAddress(COW_SHED_LOCAL_EVM_INPUT),
          ]),
        }),
      ),
    ])
    return await execFileAsync('forge', ['test', '--root', root, '-vv'], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    })
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) {
      throw new Error(`${error.message}\n${String(error.stdout)}`, {
        cause: error,
      })
    }
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
