import { getDestinationContracts } from '@ens-apps/smart-account'
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  parseAbiParameters,
  zeroHash,
} from 'viem'
import { sepolia } from 'viem/chains'
import { expect, it } from 'vitest'
import {
  getCowShedConditionalOrderHash,
  getCowShedQuoteValidity,
  prepareCowShedRegistration,
} from './registration.cow-shed'

const makeInput = () => ({
  chainId: sepolia.id,
  wallet: '0x1111111111111111111111111111111111111111' as const,
  resolver: '0x2222222222222222222222222222222222222222' as const,
  name: 'example.eth',
  duration: 31_536_000n,
  secret: zeroHash,
  commitment: zeroHash,
  registrationPrice: 8_000_000n,
  executionBudget: 100_000n,
  firstOrderValidTo: 1_800_000_000n,
  secondOrderValidTo: 1_800_003_600n,
  appDataHash: zeroHash,
  salt: zeroHash,
})

it.each([
  [1_000n, 1_300n, 4_900n],
  [4_294_963_395n, 4_294_963_695n, 4_294_967_295n],
] as const)(
  'keeps quote validity in the signed uint32 window at %s',
  (timestamp, firstOrderValidTo, secondOrderValidTo) => {
    expect(getCowShedQuoteValidity(timestamp)._unsafeUnwrap()).toEqual({
      firstOrderValidTo,
      secondOrderValidTo,
    })
  },
)

it.each([-1n, 4_294_963_396n, 9_007_199_254_740_993n])(
  'rejects a block timestamp outside the quote validity window: %s',
  (timestamp) => {
    expect(getCowShedQuoteValidity(timestamp).isErr()).toBe(true)
  },
)

it('creates a discoverable order without revoking its authorization after registration', () => {
  const prepared = prepareCowShedRegistration(makeInput())
  const authorizationAbi = parseAbi([
    'function create((address handler,bytes32 salt,bytes staticInput) params,bool dispatch)',
  ])
  const create = decodeFunctionData({
    abi: authorizationAbi,
    data: prepared.setupCalls[1].callData,
  })
  expect(create.functionName).toBe('create')
  expect(create.args).toEqual([prepared.conditionalOrder, true])
  expect(getCowShedConditionalOrderHash(prepared.conditionalOrder)).toBe(
    '0x66fbf4f2903aab366095a988be03eb11343a7db6d57f2b67bd8d22fa8b152a2f',
  )
  const approve = decodeFunctionData({
    abi: parseAbi(['function approve(address spender,uint256 amount)']),
    data: prepared.setupCalls[2].callData,
  })
  expect(approve.args).toEqual([
    '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    100_000n,
  ])
  expect(prepared.registrationCalls[2].allowFailure).toBe(false)
  expect(
    prepared.registrationCalls.some(
      ({ target }) => target === prepared.setupCalls[1].target,
    ),
  ).toBe(false)
})

it('requires registration to succeed before consuming the public hook nonce', () => {
  const prepared = prepareCowShedRegistration(makeInput())
  const contracts = getDestinationContracts(sepolia.id)
  expect(
    prepared.registrationCalls.map(({ target, allowFailure }) => ({
      target,
      allowFailure,
    })),
  ).toEqual([
    { target: contracts.usdc, allowFailure: false },
    { target: contracts.usdc, allowFailure: false },
    { target: contracts.ethRegistrar, allowFailure: false },
    { target: contracts.usdc, allowFailure: false },
    { target: contracts.usdc, allowFailure: false },
  ])
  const approvals = prepared.registrationCalls.slice(3).map(
    (item) =>
      decodeFunctionData({
        abi: parseAbi(['function approve(address spender,uint256 amount)']),
        data: item.callData,
      }).args,
  )
  expect(approvals).toEqual([
    [contracts.ethRegistrar, 0n],
    ['0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 0n],
  ])
})

it.each([
  { chainId: 1 },
  { executionBudget: 0n },
  { registrationPrice: 0n },
  { secondOrderValidTo: 1_800_000_000n },
  { secondOrderValidTo: 4_294_967_296n },
])('rejects unsafe registration parameters: %s', (override) => {
  expect(() =>
    prepareCowShedRegistration({ ...makeInput(), ...override }),
  ).toThrow()
})

it('binds the exact registrar commitment and funding to the ENS order', () => {
  const wallet = '0x1111111111111111111111111111111111111111'
  const resolver = '0x2222222222222222222222222222222222222222'
  const result = prepareCowShedRegistration({
    chainId: sepolia.id,
    wallet,
    resolver,
    name: 'example.eth',
    duration: 31_536_000n,
    secret: zeroHash,
    commitment: `0x${'cd'.repeat(32)}`,
    registrationPrice: 8_000_000n,
    executionBudget: 100_000n,
    firstOrderValidTo: 1_800_000_000n,
    secondOrderValidTo: 1_800_003_600n,
    appDataHash: zeroHash,
    salt: zeroHash,
    referrer: `0x${'ab'.repeat(32)}`,
  })
  const contracts = getDestinationContracts(sepolia.id)
  expect(result.firstOrderAmountOut).toBe(8_100_000n)
  expect(result.conditionalOrder.handler).toBe(
    '0x7A383Ef8eaBA234c82a4a7dD20686a6314F41fF1',
  )
  expect(result.conditionalOrder.staticInput).toHaveLength(578)
  const [order] = decodeAbiParameters(
    parseAbiParameters(
      '(address registrar,bytes32 commitment,address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 minSellBalance,uint256 endTime,bytes32 appData)',
    ),
    result.conditionalOrder.staticInput,
  )
  expect(order).toEqual({
    registrar: contracts.ethRegistrar,
    commitment: `0x${'cd'.repeat(32)}`,
    sellToken: contracts.usdc,
    buyToken: contracts.usdc,
    receiver: wallet,
    sellAmount: 100_000n,
    minSellBalance: 8_100_000n,
    endTime: 1_800_003_600n,
    appData: zeroHash,
  })
  const approveAbi = parseAbi([
    'function approve(address spender,uint256 amount)',
  ])
  const reset = decodeFunctionData({
    abi: approveAbi,
    data: result.registrationCalls[0].callData,
  })
  expect(reset.args).toEqual([contracts.ethRegistrar, 0n])
  const approve = decodeFunctionData({
    abi: approveAbi,
    data: result.registrationCalls[1].callData,
  })
  expect(approve.args).toEqual([contracts.ethRegistrar, 8_000_000n])
  const register = decodeFunctionData({
    abi: parseAbi([
      'function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer)',
    ]),
    data: result.registrationCalls[2].callData,
  })
  expect(register.args).toEqual([
    'example',
    wallet,
    zeroHash,
    '0x0000000000000000000000000000000000000000',
    resolver,
    31_536_000n,
    contracts.usdc,
    `0x${'ab'.repeat(32)}`,
  ])
})

it('authorizes the signed calls for the owner’s ComposableCoW Shed', async () => {
  const { createPublicClient, createWalletClient, custom } = await import(
    'viem'
  )
  const { privateKeyToAccount } = await import('viem/accounts')
  const { signCowShedCalls } = await import('./registration.cow-shed')
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const transport = custom({ request: async () => '0x' })
  const publicClient = createPublicClient({ chain: sepolia, transport })
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport,
  })
  const signed = await signCowShedCalls({
    chainId: sepolia.id,
    publicClient,
    walletClient,
    calls: [
      {
        target: account.address,
        callData: '0x',
        value: 0n,
        allowFailure: false,
        isDelegateCall: false,
      },
    ],
    nonce: zeroHash,
    deadline: 1_800_000_000n,
    gasLimit: 500_000n,
  })
  expect(signed.signedMulticall.to.toLowerCase()).toBe(
    '0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca',
  )
  const decoded = decodeFunctionData({
    abi: parseAbi([
      'function executeHooks((address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)[] calls,bytes32 nonce,uint256 deadline,address owner,bytes signature)',
    ]),
    data: signed.signedMulticall.data,
  })
  expect(decoded.args[3]).toBe(account.address)
  expect(decoded.args[0][0].target).toBe(account.address)
})

it('rejects non-Sepolia clients before requesting a hook signature', async () => {
  const { createPublicClient, createWalletClient, custom } = await import(
    'viem'
  )
  const { mainnet } = await import('viem/chains')
  const { signCowShedCalls } = await import('./registration.cow-shed')
  const transport = custom({
    request: async () => {
      throw new Error('Must not request a signature')
    },
  })
  await expect(
    signCowShedCalls({
      chainId: sepolia.id,
      publicClient: createPublicClient({ chain: mainnet, transport }),
      walletClient: createWalletClient({
        account: makeInput().wallet,
        chain: mainnet,
        transport,
      }),
      calls: [],
      nonce: zeroHash,
      deadline: 1_800_000_000n,
      gasLimit: 500_000n,
    }),
  ).rejects.toThrow('Sepolia clients')
})

it('binds the registration hook into the second order app data', async () => {
  const { createCowShedHookAppData } = await import('./registration.cow-shed')
  const target = '0x1111111111111111111111111111111111111111'
  const result = await createCowShedHookAppData({
    target,
    callData: '0x1234',
    gasLimit: 800_000,
  })
  expect(JSON.parse(result.appDataContent).metadata.hooks.post).toEqual([
    { target, callData: '0x1234', gasLimit: '800000' },
  ])
})

it('builds the single conditional order with a one-unit minimum', async () => {
  const {
    createPublicClient,
    custom,
    encodeFunctionResult,
    keccak256,
    stringToHex,
  } = await import('viem')
  const { buildCowShedOrderRequest, COW_TRADEABLE_ORDER_ABI } = await import(
    './registration.cow-shed'
  )
  const owner = '0x1111111111111111111111111111111111111111'
  const usdc = getDestinationContracts(sepolia.id).usdc
  const prepared = prepareCowShedRegistration(makeInput())
  const condition = prepared.conditionalOrder
  const order = {
    sellToken: usdc,
    buyToken: usdc,
    receiver: owner,
    sellAmount: 100_000n,
    buyAmount: 1n,
    validTo: 1_800_003_600,
    appData: zeroHash,
    feeAmount: 0n,
    kind: keccak256(stringToHex('sell')),
    partiallyFillable: false,
    sellTokenBalance: keccak256(stringToHex('erc20')),
    buyTokenBalance: keccak256(stringToHex('erc20')),
  }
  const client = createPublicClient({
    chain: sepolia,
    transport: custom({
      request: async ({ method, params }) => {
        if (method !== 'eth_call') throw new Error(`Unexpected RPC ${method}`)
        const [ethCall] = params as readonly [{ readonly data: `0x${string}` }]
        const read = decodeFunctionData({
          abi: COW_TRADEABLE_ORDER_ABI,
          data: ethCall.data,
        })
        expect(read.args[2]).toBe('0x')
        expect(read.args[3]).toEqual([])
        return encodeFunctionResult({
          abi: COW_TRADEABLE_ORDER_ABI,
          functionName: 'getTradeableOrderWithSignature',
          result: [order, '0x1234'],
        })
      },
    }),
  })
  const { getCowShedOrderUid } = await import('./registration.cow-shed')
  const { OrderSigningUtils, OrderKind, setGlobalAdapter } = await import(
    '@cowprotocol/cow-sdk'
  )
  const { ViemAdapter } = await import('@cowprotocol/sdk-viem-adapter')
  setGlobalAdapter(new ViemAdapter({ provider: client }))
  const request = await buildCowShedOrderRequest({
    publicClient: client,
    owner,
    conditionalOrder: condition,
  })
  const expectedUid = await OrderSigningUtils.generateOrderId(
    sepolia.id,
    { ...request, kind: OrderKind.SELL },
    { owner },
  )
  expect(getCowShedOrderUid(request)).toBe(expectedUid.orderId)
  expect(request).toMatchObject({
    from: owner,
    sellToken: usdc,
    buyToken: usdc,
    sellAmount: '100000',
    buyAmount: '1',
    kind: 'sell',
    signature: '0x1234',
    signingScheme: 'eip1271',
  })
})

it('rejects an unsupported conditional-order handler before reading its signature', async () => {
  const { createPublicClient, custom } = await import('viem')
  const { buildCowShedOrderRequest } = await import('./registration.cow-shed')
  const prepared = prepareCowShedRegistration(makeInput())
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: custom({
      request: async () => {
        throw new Error('Unexpected RPC call')
      },
    }),
  })
  await expect(
    buildCowShedOrderRequest({
      publicClient,
      owner: makeInput().wallet,
      conditionalOrder: {
        ...prepared.conditionalOrder,
        handler: makeInput().wallet,
      },
    }),
  ).rejects.toThrow('invalid authorization')
})

it.each([
  { receiver: '0x2222222222222222222222222222222222222222' },
  { sellToken: '0x2222222222222222222222222222222222222222' },
  { buyToken: '0x2222222222222222222222222222222222222222' },
  { sellAmount: 100_001n },
  { validTo: 1_800_003_601 },
  { appData: `0x${'ab'.repeat(32)}` },
  { kind: zeroHash },
  { sellTokenBalance: zeroHash },
  { buyTokenBalance: zeroHash },
  { buyAmount: 2n },
  { feeAmount: 1n },
  { partiallyFillable: true },
] as const)(
  'rejects returned order terms that differ from the signed terms: %s',
  async (override) => {
    const {
      createPublicClient,
      custom,
      encodeFunctionResult,
      keccak256,
      stringToHex,
    } = await import('viem')
    const { buildCowShedOrderRequest, COW_TRADEABLE_ORDER_ABI } = await import(
      './registration.cow-shed'
    )
    const prepared = prepareCowShedRegistration(makeInput())
    const usdc = getDestinationContracts(sepolia.id).usdc
    const order = {
      sellToken: usdc,
      buyToken: usdc,
      receiver: makeInput().wallet,
      sellAmount: 100_000n,
      buyAmount: 1n,
      validTo: 1_800_003_600,
      appData: zeroHash,
      feeAmount: 0n,
      kind: keccak256(stringToHex('sell')),
      partiallyFillable: false,
      sellTokenBalance: keccak256(stringToHex('erc20')),
      buyTokenBalance: keccak256(stringToHex('erc20')),
      ...override,
    }
    const client = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async () =>
          encodeFunctionResult({
            abi: COW_TRADEABLE_ORDER_ABI,
            functionName: 'getTradeableOrderWithSignature',
            result: [order, '0x1234'],
          }),
      }),
    })
    await expect(
      buildCowShedOrderRequest({
        publicClient: client,
        owner: makeInput().wallet,
        conditionalOrder: prepared.conditionalOrder,
      }),
    ).rejects.toThrow('unexpected terms')
  },
)

it.each([
  {
    scenario: 'a wei-scale gas estimate',
    gasPriceWei: 20n,
    ethUsd: 222_600_000_000n,
    expected: 1_000_000n,
  },
  {
    scenario: 'an estimate above the USDC floor',
    gasPriceWei: 100_000_000n,
    ethUsd: 400_000_000_000n,
    expected: 2_000_001n,
  },
  {
    scenario: 'higher fees with a fractional USDC base unit',
    gasPriceWei: 3_000_000_001n,
    ethUsd: 222_600_000_000n,
    expected: 33_390_002n,
  },
])(
  'budgets second-order execution for $scenario',
  async ({ gasPriceWei, ethUsd, expected }) => {
    const { estimateCowShedExecutionBudget } = await import(
      './registration.cow-shed'
    )
    expect(
      estimateCowShedExecutionBudget({
        gasUnits: 2_500_000n,
        gasPriceWei,
        ethUsd,
      }),
    ).toBe(expected)
  },
)

it('prepares both signed hooks and binds the registration hook to the conditional order', async () => {
  const { createPublicClient, createWalletClient, custom } = await import(
    'viem'
  )
  const { privateKeyToAccount } = await import('viem/accounts')
  const { prepareSignedCowShedRegistration } = await import(
    './registration.cow-shed'
  )
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const transport = custom({ request: async () => '0x' })
  const prepared = await prepareSignedCowShedRegistration({
    chainId: sepolia.id,
    wallet: account.address,
    publicClient: createPublicClient({ chain: sepolia, transport }),
    walletClient: createWalletClient({ account, chain: sepolia, transport }),
    resolver: '0x2222222222222222222222222222222222222222',
    name: 'example.eth',
    duration: 31_536_000n,
    secret: zeroHash,
    commitment: zeroHash,
    registrationPrice: 8_000_000n,
    executionBudget: 100_000n,
    firstOrderValidTo: 1_800_000_000n,
    secondOrderValidTo: 1_800_003_600n,
    salt: zeroHash,
    setupNonce: `0x${'01'.repeat(32)}`,
    registrationNonce: `0x${'02'.repeat(32)}`,
  })
  const [order] = decodeAbiParameters(
    parseAbiParameters(
      '(address registrar,bytes32 commitment,address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 minSellBalance,uint256 endTime,bytes32 appData)',
    ),
    prepared.conditionalOrder.staticInput,
  )
  expect(order.appData).toBe(prepared.registrationAppData.appDataHex)
  expect(
    JSON.parse(prepared.registrationAppData.appDataContent).metadata.hooks
      .post[0].callData,
  ).toBe(prepared.registrationHook.callData)
  expect(prepared.setupHook.callData).not.toBe(
    prepared.registrationHook.callData,
  )
  expect(prepared.firstOrderAmountOut).toBe(8_100_000n)
  const { getCowShedAddress, prepareCowShedQuoteHooks } = await import(
    './registration.cow-shed'
  )
  expect(
    getCowShedAddress({ chainId: sepolia.id, wallet: account.address }),
  ).toBe(prepared.cowShedAccount)
  const quoted = await prepareCowShedQuoteHooks({
    ...makeInput(),
    wallet: account.address,
    setupNonce: `0x${'01'.repeat(32)}`,
    registrationNonce: `0x${'02'.repeat(32)}`,
  })
  expect(quoted.setupHook.callData.length).toBe(
    prepared.setupHook.callData.length,
  )
  expect(quoted.registrationHook.callData.length).toBe(
    prepared.registrationHook.callData.length,
  )
  expect(quoted.setupHook.gasLimit).toBe(prepared.setupHook.gasLimit)
  expect(quoted.setupHook.gasLimit).toBe(3_000_000)
  expect(prepared.setupHook.gasLimit).toBe(3_000_000)
  expect(quoted.registrationHook.gasLimit).toBe(2_000_000)
  expect(prepared.registrationHook.gasLimit).toBe(2_000_000)
})
