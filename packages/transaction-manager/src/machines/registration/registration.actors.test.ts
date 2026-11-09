import { getDestinationContracts } from '@ens-apps/smart-account'
import {
  ensL1Contracts,
  extendChainWithEns,
  supportedL1Chains,
} from '@ensdomains/ensjs/chain'
import { ethRegistrarRegisterSnippet } from '@ensdomains/ensjs-abi/v2/ethRegistrar'
import { permissionedRegistryGetStateSnippet } from '@ensdomains/ensjs-abi/v2/permissionedRegistry'
import type { Address, Hash, Hex, PublicClient, WalletClient } from 'viem'
import { decodeFunctionData, getChainContractAddress, zeroAddress } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignerAddressMismatchError } from '../../errors/transaction.errors'
import type {
  EOASigner,
  RhinestoneSigner,
  Signer,
} from '../../types/signer.types'
import { type Call, getPrimaryCall } from '../../types/transaction.types'
import {
  createTransactionRequest,
  getSignerAddress,
  resolvePaymentTokenAddress,
  submitRegistrationActor,
  verifyRegistrationActor,
} from './registration.actors'

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  multicall: vi.fn(),
  startTransaction: vi.fn(
    (_intent: { readonly request: { readonly data: Hex } }) => 'tx-register',
  ),
}))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  readContract: mocks.readContract,
  multicall: mocks.multicall,
}))

vi.mock('../../providers/transactionManager', () => ({
  transactionManager: { startTransaction: mocks.startTransaction },
}))

// The oracle's token whitelist is a chain read, outside the token choice.
vi.mock('../../contracts/paymentToken', () => ({
  assertPaymentTokenSupported: vi.fn(async () => {}),
}))

const FROM = '0xF00000000000000000000000000000000000000F' as Address
const eoaSigner = { type: 'eoa' } as unknown as Signer
const rhinestoneSigner = { type: 'rhinestone' } as unknown as Signer

const permitCall: Call = {
  to: '0x1111111111111111111111111111111111111111' as Address,
  data: '0xd505accf' as Hex,
  value: 0n,
}
const registerCall: Call = {
  to: '0x2222222222222222222222222222222222222222' as Address,
  data: '0x12345678' as Hex,
  value: 7n,
}

const HCA = '0x1111111111111111111111111111111111111111' as Address
const HCA_OTHER = '0x2222222222222222222222222222222222222222' as Address

function rhinestoneSignerWith(opts: {
  liveAddress: Address
  configAddress?: Address
}): RhinestoneSigner {
  return {
    type: 'rhinestone',
    account: {
      getAddress: () => opts.liveAddress,
    } as unknown as RhinestoneSigner['account'],
    config: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal chain stub for the test
      chain: {} as any,
      rhinestoneApiKey: 'test-key',
      ...(opts.configAddress ? { accountAddress: opts.configAddress } : {}),
    },
  }
}

describe('getSignerAddress', () => {
  it('returns the connected EOA account address', () => {
    const signer = {
      type: 'eoa',
      walletClient: { account: { address: FROM } } as unknown as WalletClient,
    } as Signer
    expect(getSignerAddress(signer)).toBe(FROM)
  })

  it('throws when an EOA wallet has no connected account', () => {
    const signer = {
      type: 'eoa',
      walletClient: { account: undefined } as unknown as WalletClient,
    } as Signer
    expect(() => getSignerAddress(signer)).toThrow(/no account connected/i)
  })

  it('returns the verified rhinestone smart-account address', () => {
    const signer = rhinestoneSignerWith({
      liveAddress: HCA,
      configAddress: HCA,
    })
    expect(getSignerAddress(signer)).toBe(HCA)
  })

  it('throws SignerAddressMismatchError when the cached HCA address diverges', () => {
    const signer = rhinestoneSignerWith({
      liveAddress: HCA_OTHER,
      configAddress: HCA,
    })
    expect(() => getSignerAddress(signer)).toThrow(SignerAddressMismatchError)
  })
})

describe('createTransactionRequest', () => {
  it('derives EOA top-level fields from the single call', () => {
    const request = createTransactionRequest({
      signer: eoaSigner,
      from: FROM,
      chainId: 11155111,
      calls: [registerCall],
    })

    expect(request.type).toBe('eoa')
    if (request.type !== 'eoa') throw new Error('expected eoa request')
    // Top-level call data is exactly the (only) call — no divergent copy.
    expect(request.to).toBe(registerCall.to)
    expect(request.data).toBe(registerCall.data)
    expect(request.value).toBe(registerCall.value)
  })

  it('stores calls verbatim for a rhinestone intent with no top-level copy', () => {
    const calls = [permitCall, registerCall]
    const request = createTransactionRequest({
      signer: rhinestoneSigner,
      from: FROM,
      chainId: 11155111,
      calls,
    })

    expect(request.type).toBe('rhinestone-intent')
    if (request.type !== 'rhinestone-intent') {
      throw new Error('expected rhinestone-intent request')
    }
    // calls is the single source of truth.
    expect(request.rhinestoneParams.calls).toEqual(calls)
    // There is no top-level call data that could diverge from calls.
    expect('to' in request).toBe(false)
    expect('data' in request).toBe(false)
    expect('value' in request).toBe(false)
    // getPrimaryCall resolves the representative call from calls[0].
    expect(getPrimaryCall(request)).toEqual({
      to: permitCall.to,
      data: permitCall.data,
      value: permitCall.value,
    })
  })

  it('rejects a multi-call batch for an EOA signer', () => {
    expect(() =>
      createTransactionRequest({
        signer: eoaSigner,
        from: FROM,
        chainId: 11155111,
        calls: [permitCall, registerCall],
      }),
    ).toThrow(/single call/i)
  })

  it('rejects an empty calls array', () => {
    expect(() =>
      createTransactionRequest({
        signer: rhinestoneSigner,
        from: FROM,
        chainId: 11155111,
        calls: [],
      }),
    ).toThrow(/at least one call/i)
  })
})

describe('resolvePaymentTokenAddress', () => {
  const sepoliaChain = extendChainWithEns(sepolia)
  const mainnetChain = extendChainWithEns(mainnet)
  const mockUsdc = getChainContractAddress({
    chain: sepoliaChain,
    contract: 'usdc',
  })

  it('pays in the token the caller showed', () => {
    expect(
      resolvePaymentTokenAddress(
        { selectedToken: 'USDC', paymentTokenAddress: mockUsdc },
        sepoliaChain,
      ),
    ).toBe(mockUsdc)
  })

  it("falls back to the manifest's USDC when the caller names none", () => {
    expect(
      resolvePaymentTokenAddress({ selectedToken: 'USDC' }, sepoliaChain),
    ).toBe(getDestinationContracts(sepolia.id).usdc)
  })

  // Why the explorer's explicit token cannot change a mainnet registration:
  // the fallback there is ensjs' USDC, the token the explorer shows.
  it('resolves to the same USDC either way on mainnet', () => {
    const shown = ensL1Contracts[supportedL1Chains.mainnet].usdc.address
    expect(
      resolvePaymentTokenAddress({ selectedToken: 'USDC' }, mainnetChain),
    ).toBe(shown)
  })
})

describe('verifyRegistrationActor', () => {
  const REGISTRAR = '0x3333333333333333333333333333333333333333' as const
  const REGISTRY = '0x4444444444444444444444444444444444444444' as const
  const COMMITMENT = `0x${'55'.repeat(32)}` as Hex
  const publicClient = { chain: extendChainWithEns(sepolia) } as PublicClient
  const input = {
    name: 'alice.eth',
    owner: FROM,
    resolverAddress: HCA,
    registrarAddress: REGISTRAR,
    publicClient,
    commitment: COMMITMENT,
    graceWindowMs: 0,
  }

  beforeEach(() => {
    mocks.readContract.mockReset().mockImplementation(
      async (
        _client: PublicClient,
        request: {
          readonly address: Address
          readonly functionName: string
          readonly args?: readonly unknown[]
        },
      ) => {
        expect(request.address).toBe(REGISTRAR)
        if (request.functionName === 'commitmentAt') {
          expect(request.args).toEqual([COMMITMENT])
          return 0n
        }
        throw new Error('REGISTRY() is not supported')
      },
    )
    mocks.multicall.mockReset().mockImplementation(
      async (
        _client: PublicClient,
        request: {
          readonly contracts: readonly {
            readonly address: Address
            readonly functionName: string
            readonly args: readonly unknown[]
          }[]
        },
      ) => {
        expect(request.contracts).toEqual([
          expect.objectContaining({
            address: REGISTRY,
            functionName: 'getResolver',
            args: ['alice'],
          }),
          expect.objectContaining({
            address: REGISTRY,
            abi: permissionedRegistryGetStateSnippet,
            functionName: 'getState',
            args: [
              0x9c0257114eb9399a2985f8e75dad7600c5d89fe3824ffa99ec1c3eb8bf3b0501n,
            ],
          }),
          expect.objectContaining({
            address: REGISTRY,
            functionName: 'getSubregistry',
            args: ['alice'],
          }),
        ])
        return [
          HCA,
          {
            status: 2,
            latestOwner: FROM,
            expiry: 0n,
            tokenId: 0n,
            resource: 0n,
          },
          zeroAddress,
        ]
      },
    )
  })

  it('verifies with an explicit registry when the registrar has no REGISTRY()', async () => {
    const result = await verifyRegistrationActor({
      ...input,
      registryAddress: REGISTRY,
    })

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: true,
      registeredToOther: false,
      isUnregistered: false,
    })
  })

  it('keeps the REGISTRY() lookup when no registry address is supplied', async () => {
    mocks.readContract.mockResolvedValueOnce(REGISTRY)

    const result = await verifyRegistrationActor(input)

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: true,
      registeredToOther: false,
      isUnregistered: false,
    })
    expect(mocks.readContract).toHaveBeenCalledWith(
      publicClient,
      expect.objectContaining({
        address: REGISTRAR,
        functionName: 'REGISTRY',
      }),
    )
  })

  it('does not verify an expired registration with the expected historical owner', async () => {
    mocks.multicall.mockResolvedValueOnce([
      HCA,
      { status: 0, latestOwner: FROM, expiry: 0n, tokenId: 0n, resource: 0n },
      zeroAddress,
    ])

    const result = await verifyRegistrationActor({
      ...input,
      registryAddress: REGISTRY,
    })

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: false,
      registeredToOther: false,
      isUnregistered: true,
      reason: expect.stringContaining('owner'),
    })
    expect(mocks.multicall).toHaveBeenCalledTimes(1)
  })

  it.each(['registry state', 'commitment'] as const)(
    'returns an error when the %s RPC read fails',
    async (read) => {
      const error = new Error('RPC unavailable')
      const rpc =
        read === 'registry state' ? mocks.multicall : mocks.readContract
      rpc.mockRejectedValueOnce(error)

      const result = await verifyRegistrationActor({
        ...input,
        registryAddress: REGISTRY,
      })

      assert(result.isErr())
      expect(result.error).toBe(error)
      expect(rpc).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['resolver', [HCA_OTHER, FROM, zeroAddress], 0n, false],
    ['owner', [HCA, HCA_OTHER, zeroAddress], 0n, true],
    ['subregistry', [HCA, FROM, HCA_OTHER], 0n, false],
    ['commitment', [HCA, FROM, zeroAddress], 1_700_000n, false],
  ] as const)(
    'rejects an explicit-registry registration with a different %s',
    async (field, registryEntry, commitTime, registeredToOther) => {
      mocks.multicall.mockResolvedValueOnce([
        registryEntry[0],
        {
          status: 2,
          latestOwner: registryEntry[1],
          expiry: 0n,
          tokenId: 0n,
          resource: 0n,
        },
        registryEntry[2],
      ])
      mocks.readContract.mockResolvedValueOnce(commitTime)

      const result = await verifyRegistrationActor({
        ...input,
        registryAddress: REGISTRY,
      })

      assert(result.isOk())
      expect(result.value).toEqual({
        verified: false,
        registeredToOther,
        isUnregistered: false,
        reason: expect.stringContaining(field),
      })
    },
  )
})

describe('submitRegistrationActor', () => {
  it('registers paying in the token the caller showed', async () => {
    const owner = '0x1111111111111111111111111111111111111111' as Address
    const chain = extendChainWithEns(sepolia)
    const mockUsdc = getChainContractAddress({ chain, contract: 'usdc' })

    await submitRegistrationActor({
      name: 'alice',
      commitment: {
        commitment: `0x${'44'.repeat(32)}` as Hash,
        secret: `0x${'55'.repeat(32)}` as Hex,
      },
      signer: {
        type: 'eoa',
        walletClient: { account: { address: owner } } as WalletClient,
      } satisfies EOASigner,
      duration: 31_536_000n,
      selectedToken: 'USDC',
      paymentTokenAddress: mockUsdc,
      owner,
      publicClient: { chain } as PublicClient,
      resolverAddress: owner,
    })

    const [intent] = mocks.startTransaction.mock.calls[0] ?? []
    const { args } = decodeFunctionData({
      abi: ethRegistrarRegisterSnippet,
      data: intent?.request.data ?? '0x',
    })
    expect(args?.[6]).toBe(mockUsdc)
  })
})
