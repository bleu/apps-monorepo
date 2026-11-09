import {
  BuyTokenDestination,
  OrderBookApiError,
  OrderKind,
  SellTokenSource,
  SigningScheme,
} from '@cowprotocol/cow-sdk'
import { getDestinationContracts } from '@ens-apps/smart-account'
import {
  type Address,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  encodeFunctionResult,
  type Hash,
  HttpRequestError,
  keccak256,
  labelhash,
  parseAbi,
  stringToHex,
  TimeoutError,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from 'viem'
import { sepolia } from 'viem/chains'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const realOrderBook = vi.hoisted(() => ({ enabled: false }))
const getOrder = vi.fn()
const uploadAppData = vi.fn()
const sendOrder = vi.fn()
const getQuoteOnly = vi.fn()
const postSwapOrderFromQuote = vi.fn()
const getQuote = vi.fn()
const getCowProtocolAllowance = vi.fn()
vi.mock('@cowprotocol/cow-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cowprotocol/cow-sdk')>()
  return {
    ...actual,
    OrderBookApi: class extends actual.OrderBookApi {
      getOrder = (
        ...args: Parameters<
          InstanceType<typeof actual.OrderBookApi>['getOrder']
        >
      ) => (realOrderBook.enabled ? super.getOrder(...args) : getOrder(...args))
      uploadAppData = (
        ...args: Parameters<
          InstanceType<typeof actual.OrderBookApi>['uploadAppData']
        >
      ) =>
        realOrderBook.enabled
          ? super.uploadAppData(...args)
          : uploadAppData(...args)
      sendOrder = (
        ...args: Parameters<
          InstanceType<typeof actual.OrderBookApi>['sendOrder']
        >
      ) =>
        realOrderBook.enabled ? super.sendOrder(...args) : sendOrder(...args)
    },
    TradingSdk: class {
      getQuoteOnly = getQuoteOnly
      getQuote = getQuote
      getCowProtocolAllowance = getCowProtocolAllowance
    },
  }
})

const feedRead = vi.fn()
const registryMulticall = vi.fn()
vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  readContract: (...args: readonly unknown[]) => feedRead(...args),
  multicall: (...args: readonly unknown[]) => registryMulticall(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCowProtocolAllowance.mockResolvedValue(10n ** 30n)
  getQuoteOnly.mockRejectedValue(new Error('Unexpected quote request'))
  uploadAppData.mockResolvedValue({})
})

import { NATIVE_ETH } from '../../helpers/eth-usdc-swap'
import {
  COW_TRADEABLE_ORDER_ABI,
  type CowConditionalOrderSubmission,
  getCowShedConditionalOrderHash,
  getCowShedOrderUid,
  prepareCowShedRegistration,
} from './registration.cow-shed'
import {
  type CowShedPlan,
  quoteCowShedPaymentActor,
  runCowShedRegistrationActor,
} from './registration.cow-shed.actors'

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const SHED: Address = '0x2222222222222222222222222222222222222222'
const HASH: Hash = `0x${'11'.repeat(32)}`
const authorization = {
  chainId: sepolia.id,
  wallet: OWNER,
  resolver: OWNER,
  name: 'alice.eth',
  duration: 31_536_000n,
  secret: HASH,
  commitment: HASH,
  registrationPrice: 5_000_000n,
  executionBudget: 1_000_000n,
  firstOrderValidTo: 1_300n,
  secondOrderValidTo: 4_900n,
  salt: HASH,
  setupNonce: HASH,
  registrationNonce: `0x${'22'.repeat(32)}` as Hash,
}
const sellToken = {
  address: OWNER,
  symbol: 'TEST',
  decimals: 18,
  isNative: false,
}
const hook = { target: SHED, callData: '0xabcd' as const, gasLimit: 1_000_000 }
const makePlan = (): CowShedPlan => ({
  authorization,
  signed: {
    cowShedAccount: SHED,
    ...prepareCowShedRegistration({ ...authorization, appDataHash: HASH }),
    registrationAppData: { appDataHex: HASH, appDataContent: '{}' },
    registrationHook: hook,
    setupHook: hook,
  },
  sellToken,
  maximumSell: 10n ** 18n,
})
const makeRequest = (): CowConditionalOrderSubmission => ({
  from: SHED,
  sellToken: OWNER,
  buyToken: OWNER,
  receiver: OWNER,
  sellAmount: '1000000',
  buyAmount: '1',
  validTo: 4_900,
  appData: HASH,
  feeAmount: '0',
  kind: OrderKind.SELL,
  partiallyFillable: false,
  sellTokenBalance: SellTokenSource.ERC20,
  buyTokenBalance: BuyTokenDestination.ERC20,
  signingScheme: SigningScheme.EIP1271,
  signature: '0x1234',
})

const makeInput = (
  request = vi.fn().mockRejectedValue(new Error('Unexpected external request')),
) => {
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: custom({ request }, { retryCount: 0 }),
  })
  const walletClient = createWalletClient({
    account: OWNER,
    chain: sepolia,
    transport: custom({ request }, { retryCount: 0 }),
  })
  vi.spyOn(publicClient, 'getBlock').mockResolvedValue({
    timestamp: 1_000n,
  } as Awaited<ReturnType<typeof publicClient.getBlock>>)
  return {
    ...authorization,
    owner: OWNER,
    publicClient,
    walletClient,
    firstOrderValidTo: 1_300,
    maximumSell: 10n ** 18n,
    sellToken,
    onProgress: vi.fn().mockResolvedValue(undefined),
  }
}

const makeTradeableOrder = () => {
  const usdc = getDestinationContracts(sepolia.id).usdc
  return [
    {
      sellToken: usdc,
      buyToken: usdc,
      receiver: OWNER,
      sellAmount: 1_000_000n,
      buyAmount: 1n,
      validTo: 4_900,
      appData: HASH,
      feeAmount: 0n,
      kind: keccak256(stringToHex('sell')),
      partiallyFillable: false,
      sellTokenBalance: keccak256(stringToHex('erc20')),
      buyTokenBalance: keccak256(stringToHex('erc20')),
    },
    '0x1234',
  ] as const
}

const pollingError = (
  errorName: 'PollTryAtEpoch' | 'PollTryNextBlock',
  timestamp = 1_500n,
) =>
  new ContractFunctionRevertedError({
    abi: COW_TRADEABLE_ORDER_ABI,
    functionName: 'getTradeableOrderWithSignature',
    data:
      errorName === 'PollTryAtEpoch'
        ? encodeErrorResult({
            abi: COW_TRADEABLE_ORDER_ABI,
            errorName,
            args: [timestamp, 'commitment too new'],
          })
        : encodeErrorResult({
            abi: COW_TRADEABLE_ORDER_ABI,
            errorName,
            args: ['commitment missing'],
          }),
  })

const mockReadiness = (
  input: ReturnType<typeof makeInput>,
  isSingleOrderAuthorized: boolean,
) => {
  vi.spyOn(input.publicClient, 'getBlock').mockResolvedValue({
    timestamp: 1_500n,
  } as Awaited<ReturnType<typeof input.publicClient.getBlock>>)
  const values: Readonly<Record<string, unknown>> = {
    commitmentAt: 1_100n,
    MIN_COMMITMENT_AGE: 300n,
    MAX_COMMITMENT_AGE: 86_400n,
    singleOrders: isSingleOrderAuthorized,
    balanceOf: 6_000_000n,
    getRegisterPrice: [5_000_000n, 0n],
    getTradeableOrderWithSignature: makeTradeableOrder(),
  }
  return vi
    .spyOn(input.publicClient, 'readContract')
    .mockImplementation(async ({ functionName }) => {
      if (!(functionName in values))
        throw new Error(`Unexpected read: ${functionName}`)
      return values[functionName]
    })
}

describe('CoW Shed checkout', () => {
  it.each([
    { maxFeePerGas: 20n, executionBudget: 1_000_000n, usdcToBuy: 6_000_000n },
    {
      maxFeePerGas: 3_000_000_000n,
      executionBudget: 30_000_001n,
      usdcToBuy: 35_000_001n,
    },
  ])(
    'quotes funding at $maxFeePerGas wei before signing',
    async ({ maxFeePerGas, executionBudget, usdcToBuy }) => {
      const input = makeInput()
      vi.spyOn(input.publicClient, 'estimateFeesPerGas').mockResolvedValue({
        maxFeePerGas,
        maxPriorityFeePerGas: 2n,
      })
      feedRead.mockResolvedValue([1n, 200_000_000_000n, 1_000n, 1_000n, 1n])
      getQuoteOnly.mockResolvedValue({
        orderToSign: { sellAmount: '1000000000000000000', validTo: 1_300 },
      })
      const result = await quoteCowShedPaymentActor({
        owner: OWNER,
        publicClient: input.publicClient,
        chainId: sepolia.id,
        registrationPrice: 5_000_000n,
        sellToken,
      })
      expect(result._unsafeUnwrap()).toMatchObject({
        usdcToBuy,
        executionBudget,
        firstOrderValidTo: 1_300,
        swap: { amountOut: usdcToBuy, maximumSell: 10n ** 18n },
      })
      expect(getQuoteOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: usdcToBuy.toString(),
          validTo: 1_300,
        }),
        expect.objectContaining({
          appData: expect.objectContaining({
            metadata: expect.objectContaining({
              hooks: expect.objectContaining({
                post: expect.arrayContaining([
                  expect.objectContaining({ gasLimit: '3000000' }),
                ]),
              }),
            }),
          }),
        }),
      )
    },
  )
})

const makeNativeFundingProgress = () => {
  const funding = {
    orderId: 'saved-native-funding',
    kind: 'native',
    hash: HASH,
    amountOut: 6_000_000n,
    validTo: 1_300,
  } as const
  return {
    stage: 'fundingSent',
    plan: { ...makePlan(), sellToken: NATIVE_ETH, funding },
    funding,
  } as const
}

describe('CoW Shed registration recovery', () => {
  it.each(['success', 'reverted'] as const)(
    'completes native wallet evidence only after a successful saved receipt: %s',
    async (status) => {
      const input = makeInput()
      const onWalletProgress = vi.fn()
      const receipt =
        Promise.withResolvers<
          Awaited<ReturnType<typeof input.publicClient.getTransactionReceipt>>
        >()
      const readReceipt = vi
        .spyOn(input.publicClient, 'getTransactionReceipt')
        .mockReturnValue(receipt.promise)
      mockReadiness(input, true)
      getOrder.mockResolvedValue({ status: 'fulfilled' })
      sendOrder.mockImplementation(async (request) =>
        getCowShedOrderUid(request),
      )
      const pending = runCowShedRegistrationActor({
        ...input,
        sellToken: NATIVE_ETH,
        progress: makeNativeFundingProgress(),
        onWalletProgress,
      })
      await vi.waitFor(() => expect(readReceipt).toHaveBeenCalledOnce())
      expect(onWalletProgress).not.toHaveBeenCalled()
      receipt.resolve({ status } as Awaited<
        ReturnType<typeof input.publicClient.getTransactionReceipt>
      >)
      const result = await pending
      expect(result.isOk()).toBe(status === 'success')
      expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual(
        status === 'success'
          ? [{ action: 'nativePayment', phase: 'completed' }]
          : [],
      )
    },
  )

  it('checks the saved native creation receipt before settling its exact funding order', async () => {
    const input = makeInput()
    const progress = makeNativeFundingProgress()
    mockReadiness(input, true)
    const receipt = vi
      .spyOn(input.publicClient, 'getTransactionReceipt')
      .mockResolvedValue({ status: 'success' } as Awaited<
        ReturnType<typeof input.publicClient.getTransactionReceipt>
      >)
    const sign = vi.spyOn(input.walletClient, 'signTypedData')
    const send = vi.spyOn(input.walletClient, 'sendTransaction')
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    sendOrder.mockImplementation(async (request) => getCowShedOrderUid(request))

    const result = await runCowShedRegistrationActor({
      ...input,
      sellToken: NATIVE_ETH,
      progress,
    })

    expect(result).toMatchObject({ value: { cowShedAccount: SHED } })
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ hash: HASH })
    expect(receipt.mock.invocationCallOrder[0]).toBeLessThan(
      getOrder.mock.invocationCallOrder[0],
    )
    expect(getOrder.mock.calls[0]).toEqual(['saved-native-funding'])
    expect(input.onProgress.mock.calls.map(([saved]) => saved.stage)).toEqual([
      'funded',
      'publishing',
      'revealSent',
      'settled',
    ])
    for (const [saved] of input.onProgress.mock.calls) {
      expect(saved.plan.funding).toBe(progress.funding)
      expect(saved.plan.signed).toBe(progress.plan.signed)
    }
    expect(sign).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('reports a failed saved ETH creation transaction without polling or purchasing again', async () => {
    const input = makeInput()
    const progress = makeNativeFundingProgress()
    vi.spyOn(input.publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'reverted',
    } as Awaited<ReturnType<typeof input.publicClient.getTransactionReceipt>>)
    mockReadiness(input, true)
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    sendOrder.mockImplementation(async (request) => getCowShedOrderUid(request))
    const send = vi.spyOn(input.walletClient, 'sendTransaction')

    const result = await runCowShedRegistrationActor({
      ...input,
      sellToken: NATIVE_ETH,
      progress,
    })

    expect(result).toMatchObject({
      error: {
        cowShedAccount: SHED,
        cause: 'The ETH funding creation transaction failed on-chain.',
        message: expect.stringContaining('No new purchase will be made.'),
      },
    })
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(getOrder).not.toHaveBeenCalled()
    expect(sendOrder).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each([
    ['pending receipt', new TransactionReceiptNotFoundError({ hash: HASH })],
    [
      'RPC outage',
      new HttpRequestError({ status: 503, url: 'https://rpc.test' }),
    ],
  ] as const)(
    'retries a saved native creation %s before polling settlement',
    async (_reason, cause) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        const progress = makeNativeFundingProgress()
        mockReadiness(input, true)
        const receipt = vi
          .spyOn(input.publicClient, 'getTransactionReceipt')
          .mockRejectedValueOnce(cause)
          .mockResolvedValue({ status: 'success' } as Awaited<
            ReturnType<typeof input.publicClient.getTransactionReceipt>
          >)
        const send = vi.spyOn(input.walletClient, 'sendTransaction')
        getOrder.mockResolvedValue({ status: 'fulfilled' })
        sendOrder.mockImplementation(async (request) =>
          getCowShedOrderUid(request),
        )
        const pending = runCowShedRegistrationActor({
          ...input,
          sellToken: NATIVE_ETH,
          progress,
        })

        await vi.advanceTimersByTimeAsync(4_999)
        expect(receipt).toHaveBeenCalledTimes(1)
        expect(getOrder).not.toHaveBeenCalled()
        expect(input.onProgress).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(receipt.mock.calls).toEqual([[{ hash: HASH }], [{ hash: HASH }]])
        expect(getOrder.mock.calls[0]).toEqual(['saved-native-funding'])
        expect(input.onProgress.mock.calls[0]?.[0]).toEqual({
          stage: 'funded',
          plan: progress.plan,
        })
        expect(send).not.toHaveBeenCalled()
        expect(getQuoteOnly).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([
    ['pending receipt', new TransactionReceiptNotFoundError({ hash: HASH })],
    [
      'RPC outage',
      new HttpRequestError({ status: 503, url: 'https://rpc.test' }),
    ],
  ] as const)(
    'bounds a continuous native creation %s without another purchase',
    async (_reason, cause) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        const input = makeInput()
        const receipt = vi
          .spyOn(input.publicClient, 'getTransactionReceipt')
          .mockRejectedValue(cause)
        const send = vi.spyOn(input.walletClient, 'sendTransaction')
        const complete = vi.fn()
        const pending = runCowShedRegistrationActor({
          ...input,
          sellToken: NATIVE_ETH,
          progress: makeNativeFundingProgress(),
        })
        void pending.then(complete)

        await vi.advanceTimersByTimeAsync(100_000)
        expect(complete).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(20_000)
        expect(await pending).toMatchObject({ error: { cause } })
        const lookups = receipt.mock.calls.length
        await vi.advanceTimersByTimeAsync(120_000)
        expect(receipt).toHaveBeenCalledTimes(lookups)
        expect(input.onProgress).not.toHaveBeenCalled()
        expect(getOrder).not.toHaveBeenCalled()
        expect(sendOrder).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(getQuoteOnly).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['receipt lookup', 'receipt retry'] as const)(
    'stops native funding after cancellation during a %s',
    async (step) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        const controller = new AbortController()
        const receipt = vi.spyOn(input.publicClient, 'getTransactionReceipt')
        if (step === 'receipt lookup') {
          receipt.mockImplementation(async () => {
            controller.abort(new Error('Stopped'))
            return { status: 'success' } as Awaited<
              ReturnType<typeof input.publicClient.getTransactionReceipt>
            >
          })
        } else {
          receipt.mockRejectedValue(
            new TransactionReceiptNotFoundError({ hash: HASH }),
          )
        }
        const send = vi.spyOn(input.walletClient, 'sendTransaction')
        const pending = runCowShedRegistrationActor({
          ...input,
          sellToken: NATIVE_ETH,
          progress: makeNativeFundingProgress(),
          signal: controller.signal,
        })

        await vi.advanceTimersByTimeAsync(1_000)
        controller.abort(new Error('Stopped'))
        expect(await pending).toMatchObject({
          error: { cause: new Error('Stopped') },
        })
        await vi.advanceTimersByTimeAsync(120_000)
        expect(receipt).toHaveBeenCalledExactlyOnceWith({ hash: HASH })
        expect(input.onProgress).not.toHaveBeenCalled()
        expect(getOrder).not.toHaveBeenCalled()
        expect(sendOrder).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(getQuoteOnly).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([
    { step: 'appData', uploadCount: 2, postCount: 1 },
    { step: 'publication', uploadCount: 1, postCount: 2 },
    { step: 'lookup', uploadCount: 0, postCount: 0 },
  ] as const)(
    'retries an SDK fetch rejection during $step without a new purchase',
    async ({ step, uploadCount, postCount }) => {
      vi.useFakeTimers()
      realOrderBook.enabled = true
      const failure = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const posts = vi.fn()
      const uploads = vi.fn()
      const lookups = vi.fn()
      const headers = { 'Content-Type': 'application/json' }
      const handlers: Readonly<
        Record<string, (init: RequestInit) => Promise<Response>>
      > = {
        POST: async (init) => {
          posts(init.body)
          if (step === 'publication') await failure()
          return new Response(
            JSON.stringify(getCowShedOrderUid(JSON.parse(String(init.body)))),
            { headers },
          )
        },
        PUT: async (init) => {
          uploads(init.body)
          if (step === 'appData') await failure()
          return new Response(JSON.stringify({}), { headers })
        },
        GET: async () => {
          if (step === 'lookup') await failure()
          if (step === 'publication' && posts.mock.calls.length === 1)
            return new Response(
              JSON.stringify({ errorType: 'OrderNotFound' }),
              { status: 404, headers },
            )
          return new Response(JSON.stringify({ status: 'fulfilled' }), {
            headers,
          })
        },
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown, init: RequestInit) => {
          if (init.method === 'GET') lookups(url)
          const handler = handlers[init.method ?? 'GET']
          if (!handler) throw new Error(`Unexpected method: ${init.method}`)
          return handler(init)
        }),
      )
      try {
        const input = makeInput()
        mockReadiness(input, true)
        const request = makeRequest()
        const plan = makePlan()
        const pending = runCowShedRegistrationActor({
          ...input,
          progress:
            step === 'lookup'
              ? {
                  stage: 'publishing',
                  plan,
                  request,
                  orderId: getCowShedOrderUid(request),
                }
              : { stage: 'funded', plan },
        })
        const complete = vi.fn()
        void pending.then(complete)
        await vi.advanceTimersByTimeAsync(4_999)
        expect(complete).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(uploads).toHaveBeenCalledTimes(uploadCount)
        expect(posts).toHaveBeenCalledTimes(postCount)
        expect(posts.mock.calls.slice(1)).toEqual(posts.mock.calls.slice(0, -1))
        expect(lookups.mock.calls.slice(1)).toEqual(
          lookups.mock.calls.slice(0, -1),
        )
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
        expect(getQuoteOnly).not.toHaveBeenCalled()
      } finally {
        realOrderBook.enabled = false
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    },
  )

  it.each([
    { message: 'Failed to fetch', isTransient: true },
    { message: 'Cannot read properties of undefined', isTransient: false },
  ])(
    'bounds an SDK upload failure without retrying a programming error: $message',
    async ({ message, isTransient }) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      realOrderBook.enabled = true
      const cause = new TypeError(message)
      const fetch = vi.fn().mockRejectedValue(cause)
      vi.stubGlobal('fetch', fetch)
      try {
        const input = makeInput()
        mockReadiness(input, true)
        const complete = vi.fn()
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan: makePlan() },
        })
        void pending.then(complete)
        await vi.advanceTimersByTimeAsync(100_000)
        expect(complete).toHaveBeenCalledTimes(isTransient ? 0 : 1)
        await vi.advanceTimersByTimeAsync(20_000)
        const error = (await pending)._unsafeUnwrapErr()
        expect(error).toMatchObject({ cause: isTransient ? { cause } : cause })
        const attempts = fetch.mock.calls.length
        expect(attempts).toBe(isTransient ? 9 : 1)
        await vi.advanceTimersByTimeAsync(120_000)
        expect(fetch).toHaveBeenCalledTimes(attempts)
        expect(input.onProgress).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        realOrderBook.enabled = false
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    },
  )

  it('does not let SDK retries publish after cancellation', async () => {
    vi.useFakeTimers()
    realOrderBook.enabled = true
    const controller = new AbortController()
    const posts = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        if (init.method === 'POST') {
          posts()
          if (posts.mock.calls.length === 1)
            return new Response(JSON.stringify({ errorType: 'RateLimited' }), {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '20',
              },
            })
          return new Response(JSON.stringify('unexpected-retry'), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(HASH), {
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    try {
      const input = makeInput()
      mockReadiness(input, true)
      const pending = runCowShedRegistrationActor({
        ...input,
        signal: controller.signal,
        progress: { stage: 'funded', plan: makePlan() },
      })
      await vi.advanceTimersByTimeAsync(50)
      expect(posts).toHaveBeenCalledTimes(1)
      controller.abort(new Error('Stopped'))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await pending).toMatchObject({
        error: { cause: new Error('Stopped') },
      })
      expect(posts).toHaveBeenCalledTimes(1)
      expect(
        input.onProgress.mock.calls.map(([progress]) => progress.stage),
      ).toEqual(['publishing'])
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    } finally {
      realOrderBook.enabled = false
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it.each(['fundingSent', 'revealSent'] as const)(
    'keeps confirming %s through a temporary RPC failure',
    async (stage) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        mockReadiness(input, true)
        vi.spyOn(input.publicClient, 'getBlock')
          .mockRejectedValueOnce(
            new HttpRequestError({ status: 503, url: 'https://rpc.test' }),
          )
          .mockResolvedValueOnce({ timestamp: 1_200n } as Awaited<
            ReturnType<typeof input.publicClient.getBlock>
          >)
          .mockResolvedValue({ timestamp: 1_500n } as Awaited<
            ReturnType<typeof input.publicClient.getBlock>
          >)
        feedRead.mockResolvedValue(0n)
        registryMulticall.mockResolvedValue([
          zeroAddress,
          { status: 0, latestOwner: zeroAddress },
          zeroAddress,
        ])
        getOrder
          .mockResolvedValueOnce({ status: 'open' })
          .mockResolvedValue({ status: 'fulfilled' })
        sendOrder.mockImplementation(async (request) =>
          getCowShedOrderUid(request),
        )
        const plan = makePlan()
        const progress =
          stage === 'fundingSent'
            ? {
                stage,
                plan,
                funding: {
                  orderId: 'funding',
                  kind: 'erc20' as const,
                  amountOut: 6_000_000n,
                  validTo: 1_300,
                },
              }
            : { stage, plan, orderId: 'reveal' }
        const pending = runCowShedRegistrationActor({ ...input, progress })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        feedRead.mockReset()
        registryMulticall.mockReset()
        vi.useRealTimers()
      }
    },
  )

  it.each([
    [
      'readiness',
      new HttpRequestError({ status: 503, url: 'https://rpc.test' }),
    ],
    ['appData', new HttpRequestError({ status: 503, url: 'https://api.test' })],
  ] as const)(
    'recovers a temporary %s failure without another purchase',
    async (step, cause) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        const plan = makePlan()
        const read = mockReadiness(input, true)
        if (step === 'readiness') read.mockRejectedValueOnce(cause)
        else uploadAppData.mockRejectedValueOnce(cause)
        sendOrder.mockImplementation(async (request) =>
          getCowShedOrderUid(request),
        )
        getOrder.mockResolvedValue({ status: 'fulfilled' })
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan },
        })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(sendOrder).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(sendOrder).toHaveBeenCalledTimes(1)
        for (const args of uploadAppData.mock.calls)
          expect(args).toEqual([HASH, '{}'])
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['known', 'missing'] as const)(
    'reconciles a lost publication acknowledgement when the saved UID is %s',
    async (visibility) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        mockReadiness(input, true)
        sendOrder
          .mockRejectedValueOnce(
            new HttpRequestError({ status: 503, url: 'https://api.test' }),
          )
          .mockImplementation(async (request) => getCowShedOrderUid(request))
        const unavailable = new OrderBookApiError(
          new Response('', { status: 503 }),
          {},
        )
        getOrder.mockRejectedValueOnce(unavailable)
        if (visibility === 'missing')
          getOrder.mockRejectedValueOnce(
            new OrderBookApiError(new Response('', { status: 404 }), {
              errorType: 'OrderNotFound',
            }),
          )
        getOrder.mockResolvedValue({ status: 'fulfilled' })
        const plan = makePlan()
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan },
        })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(sendOrder).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(sendOrder).toHaveBeenCalledTimes(visibility === 'known' ? 1 : 2)
        const publication = input.onProgress.mock.calls.find(
          ([progress]) => progress.stage === 'publishing',
        )?.[0]
        for (const [request] of sendOrder.mock.calls)
          expect(request).toBe(publication.request)
        for (const [uid] of getOrder.mock.calls)
          expect(uid).toBe(publication.orderId)
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['visible', 'missing'] as const)(
    'allows commitment visibility to catch up after funding: %s',
    async (visibility) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        const input = makeInput()
        const read = mockReadiness(input, true)
        const readyRead = read.getMockImplementation()
        read.mockImplementation(async (args) =>
          args.functionName === 'commitmentAt'
            ? visibility === 'visible' && Date.now() >= 10_000
              ? 1_100n
              : 0n
            : readyRead?.(args),
        )
        feedRead.mockResolvedValue(0n)
        registryMulticall.mockResolvedValue([
          zeroAddress,
          { status: 0, latestOwner: zeroAddress },
          zeroAddress,
        ])
        getOrder.mockResolvedValue({ status: 'fulfilled' })
        sendOrder.mockImplementation(async (request) =>
          getCowShedOrderUid(request),
        )
        const complete = vi.fn()
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan: makePlan() },
        })
        void pending.then(complete)
        await vi.advanceTimersByTimeAsync(
          visibility === 'visible' ? 9_999 : 29_999,
        )
        expect(complete).not.toHaveBeenCalled()
        expect(sendOrder).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        const result = await pending
        if (visibility === 'visible') {
          expect(result).toMatchObject({ value: { cowShedAccount: SHED } })
          expect(sendOrder).toHaveBeenCalledTimes(1)
        } else {
          expect(result).toMatchObject({
            error: {
              cause: 'The funding order did not record the commitment.',
            },
          })
          expect(sendOrder).not.toHaveBeenCalled()
        }
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        feedRead.mockReset()
        registryMulticall.mockReset()
        vi.useRealTimers()
      }
    },
  )

  it.each([
    ['next block', pollingError('PollTryNextBlock')],
    ['RPC timeout', new TimeoutError({ body: {}, url: 'https://rpc.test' })],
  ] as const)('retries order generation after a %s', async (_reason, cause) => {
    vi.useFakeTimers()
    try {
      const input = makeInput()
      const read = mockReadiness(input, true)
      const readyRead = read.getMockImplementation()
      const generate = vi
        .fn()
        .mockRejectedValueOnce(cause)
        .mockResolvedValue(makeTradeableOrder())
      read.mockImplementation(async (args) =>
        args.functionName === 'getTradeableOrderWithSignature'
          ? generate()
          : readyRead?.(args),
      )
      getOrder.mockResolvedValue({ status: 'fulfilled' })
      sendOrder.mockImplementation(async (request) =>
        getCowShedOrderUid(request),
      )
      const pending = runCowShedRegistrationActor({
        ...input,
        progress: { stage: 'funded', plan: makePlan() },
      })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(generate).toHaveBeenCalledTimes(1)
      expect(sendOrder).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
      expect(generate).toHaveBeenCalledTimes(2)
      expect(sendOrder).toHaveBeenCalledTimes(1)
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['readiness', 'appData', 'nextBlock', 'publication'] as const)(
    'bounds a continuous %s outage without resetting its deadline',
    async (step) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        const input = makeInput()
        const read = mockReadiness(input, true)
        const cause =
          step === 'nextBlock'
            ? pollingError('PollTryNextBlock')
            : new HttpRequestError({ status: 503, url: 'https://api.test' })
        if (step === 'readiness') read.mockRejectedValue(cause)
        if (step === 'appData') uploadAppData.mockRejectedValue(cause)
        if (step === 'nextBlock') {
          const readyRead = read.getMockImplementation()
          read.mockImplementation(async (args) => {
            if (args.functionName === 'getTradeableOrderWithSignature')
              throw cause
            return readyRead?.(args)
          })
        }
        const request = makeRequest()
        getOrder.mockRejectedValue(cause)
        const progress =
          step === 'publication'
            ? {
                stage: 'publishing' as const,
                plan: makePlan(),
                request,
                orderId: getCowShedOrderUid(request),
              }
            : { stage: 'funded' as const, plan: makePlan() }
        const complete = vi.fn()
        const pending = runCowShedRegistrationActor({ ...input, progress })
        void pending.then(complete)
        await vi.advanceTimersByTimeAsync(100_000)
        expect(complete).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(20_000)
        expect(await pending).toMatchObject({ error: { cause } })
        const reads = read.mock.calls.length
        const uploads = uploadAppData.mock.calls.length
        const lookups = getOrder.mock.calls.length
        await vi.advanceTimersByTimeAsync(120_000)
        expect(read).toHaveBeenCalledTimes(reads)
        expect(uploadAppData).toHaveBeenCalledTimes(uploads)
        expect(getOrder).toHaveBeenCalledTimes(lookups)
        expect(sendOrder).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        uploadAppData.mockResolvedValue({})
        vi.useRealTimers()
      }
    },
  )

  it('does not save funding completion after cancellation during an in-flight lookup', async () => {
    const input = makeInput()
    const controller = new AbortController()
    getOrder.mockImplementationOnce(async () => {
      controller.abort(new Error('Stopped'))
      return { status: 'fulfilled' }
    })
    const result = await runCowShedRegistrationActor({
      ...input,
      signal: controller.signal,
      progress: {
        stage: 'fundingSent',
        plan: makePlan(),
        funding: {
          orderId: 'funding',
          kind: 'erc20',
          amountOut: 6_000_000n,
          validTo: 1_300,
        },
      },
    })
    expect(result.isErr()).toBe(true)
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(sendOrder).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each(['epoch', 'appData', 'publication'] as const)(
    'stops a pending %s retry when cancelled',
    async (step) => {
      vi.useFakeTimers()
      try {
        const input = makeInput()
        const read = mockReadiness(input, true)
        const readyRead = read.getMockImplementation()
        const cause = new HttpRequestError({
          status: 503,
          url: 'https://api.test',
        })
        if (step === 'epoch')
          read.mockImplementation(async (args) => {
            if (args.functionName === 'getTradeableOrderWithSignature')
              throw pollingError('PollTryAtEpoch', 1_600n)
            return readyRead?.(args)
          })
        if (step === 'appData') uploadAppData.mockRejectedValue(cause)
        sendOrder.mockRejectedValue(cause)
        const controller = new AbortController()
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan: makePlan() },
          signal: controller.signal,
        })
        await vi.advanceTimersByTimeAsync(1_000)
        controller.abort(new Error('Stopped'))
        expect(await pending).toMatchObject({
          error: { cause: new Error('Stopped') },
        })
        await vi.advanceTimersByTimeAsync(120_000)
        expect(
          input.onProgress.mock.calls.map(([progress]) => progress.stage),
        ).toEqual(step === 'publication' ? ['publishing'] : [])
        expect(sendOrder).toHaveBeenCalledTimes(step === 'publication' ? 1 : 0)
        expect(getOrder).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        uploadAppData.mockResolvedValue({})
        vi.useRealTimers()
      }
    },
  )

  it('stops repeated epoch hints at the original signed expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const input = makeInput()
      const read = mockReadiness(input, true)
      const readyRead = read.getMockImplementation()
      read.mockImplementation(async (args) => {
        if (args.functionName === 'getTradeableOrderWithSignature')
          throw pollingError('PollTryAtEpoch', 5_000n)
        return readyRead?.(args)
      })
      vi.spyOn(input.publicClient, 'getBlock').mockImplementation(
        async () =>
          ({
            timestamp: 1_500n + BigInt(Math.floor(Date.now() / 1_000)),
          }) as Awaited<ReturnType<typeof input.publicClient.getBlock>>,
      )
      const pending = runCowShedRegistrationActor({
        ...input,
        progress: { stage: 'funded', plan: makePlan() },
      })
      await vi.advanceTimersByTimeAsync(3_405_000)
      expect(await pending).toMatchObject({
        error: { cause: 'The registration authorization expired.' },
      })
      expect(input.onProgress).not.toHaveBeenCalled()
      expect(sendOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors Retry-After before uploading the same app data again', async () => {
    vi.useFakeTimers()
    try {
      const input = makeInput()
      mockReadiness(input, true)
      uploadAppData.mockRejectedValueOnce(
        new OrderBookApiError(
          new Response('', { status: 429, headers: { 'Retry-After': '20' } }),
          {},
        ),
      )
      getOrder.mockResolvedValue({ status: 'fulfilled' })
      sendOrder.mockImplementation(async (request) =>
        getCowShedOrderUid(request),
      )
      const pending = runCowShedRegistrationActor({
        ...input,
        progress: { stage: 'funded', plan: makePlan() },
      })
      await vi.advanceTimersByTimeAsync(19_999)
      expect(uploadAppData).toHaveBeenCalledTimes(1)
      expect(sendOrder).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toMatchObject({ value: { cowShedAccount: SHED } })
      expect(uploadAppData.mock.calls).toEqual([
        [HASH, '{}'],
        [HASH, '{}'],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([10, 180])(
    'waits %s seconds for an encoded commitment epoch without signing or funding again',
    async (waitSeconds) => {
      vi.useFakeTimers()
      try {
        const rpc = vi
          .fn()
          .mockRejectedValueOnce({
            code: 3,
            message: 'execution reverted',
            data: encodeErrorResult({
              abi: parseAbi([
                'error PollTryAtEpoch(uint256 timestamp,string reason)',
              ]),
              errorName: 'PollTryAtEpoch',
              args: [1_500n + BigInt(waitSeconds), 'commitment too new'],
            }),
          })
          .mockResolvedValue(
            encodeFunctionResult({
              abi: COW_TRADEABLE_ORDER_ABI,
              functionName: 'getTradeableOrderWithSignature',
              result: makeTradeableOrder(),
            }),
          )
        const input = makeInput(rpc)
        const generate = input.publicClient.readContract
        const read = mockReadiness(input, true)
        const readyRead = read.getMockImplementation()
        read.mockImplementation(async (args) =>
          args.functionName === 'getTradeableOrderWithSignature'
            ? generate(args)
            : readyRead?.(args),
        )
        vi.spyOn(input.publicClient, 'getBlock').mockImplementation(
          async () =>
            ({
              timestamp: 1_500n + BigInt(Math.floor(Date.now() / 1_000)),
            }) as Awaited<ReturnType<typeof input.publicClient.getBlock>>,
        )
        vi.setSystemTime(0)
        const sign = vi.spyOn(input.walletClient, 'signTypedData')
        const plan = makePlan()
        sendOrder.mockImplementation(async (request) =>
          getCowShedOrderUid(request),
        )
        getOrder.mockResolvedValue({ status: 'fulfilled' })
        const pending = runCowShedRegistrationActor({
          ...input,
          progress: { stage: 'funded', plan },
        })
        await vi.advanceTimersByTimeAsync(waitSeconds * 1_000 - 1)
        expect(sendOrder).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        const result = await pending
        expect(result).toMatchObject({ value: { cowShedAccount: SHED } })
        expect(sendOrder).toHaveBeenCalledTimes(1)
        expect(rpc).toHaveBeenCalledTimes(2)
        expect(
          input.onProgress.mock.calls.map(([progress]) => progress.stage),
        ).toEqual(['publishing', 'revealSent', 'settled'])
        for (const [progress] of input.onProgress.mock.calls)
          expect(progress.plan.signed).toBe(plan.signed)
        expect(sign).not.toHaveBeenCalled()
        expect(getQuoteOnly).not.toHaveBeenCalled()
        expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('rejects an already authorized single order before preflight or purchase', async () => {
    const input = makeInput()
    const read = vi
      .spyOn(input.publicClient, 'readContract')
      .mockImplementation(async ({ functionName }) => {
        if (functionName === 'singleOrders') return true
        throw new Error(`Unexpected read: ${functionName}`)
      })
    const preflight = vi.spyOn(input.publicClient, 'call')
    const plan = makePlan()
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan },
    })
    expect(result).toMatchObject({
      error: {
        cause: 'This Shed already has a conditional order.',
        cowShedAccount: SHED,
      },
    })
    if (result.isErr())
      expect(result.error.message).toContain('payment was not submitted')
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'singleOrders',
        args: [
          SHED,
          getCowShedConditionalOrderHash(plan.signed.conditionalOrder),
        ],
      }),
    )
    expect(preflight).not.toHaveBeenCalled()
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('publishes at the live minimum age without rebuilding saved hooks', async () => {
    const input = makeInput()
    const plan = makePlan()
    const read = mockReadiness(input, true)
    vi.spyOn(input.publicClient, 'getBlock').mockResolvedValue({
      timestamp: 1_400n,
    } as Awaited<ReturnType<typeof input.publicClient.getBlock>>)
    const sign = vi.spyOn(input.walletClient, 'signTypedData')
    const preflight = vi.spyOn(input.publicClient, 'call')
    sendOrder.mockImplementation(async () => {
      const progress = input.onProgress.mock.calls.at(-1)?.[0]
      return progress.orderId
    })
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'funded', plan },
      signal: AbortSignal.timeout(250),
    })
    expect(result).toMatchObject({ value: { cowShedAccount: SHED } })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'commitmentAt',
        args: [authorization.commitment],
      }),
    )
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'MAX_COMMITMENT_AGE' }),
    )
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'getTradeableOrderWithSignature',
        args: [SHED, plan.signed.conditionalOrder, '0x', []],
      }),
    )
    expect(
      input.onProgress.mock.calls.map(([progress]) => progress.stage),
    ).toEqual(['publishing', 'revealSent', 'settled'])
    for (const [progress] of input.onProgress.mock.calls)
      expect(progress.plan.signed).toBe(plan.signed)
    expect(sign).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('does not publish or repurchase when a funded single order has no authorization', async () => {
    const input = makeInput()
    mockReadiness(input, false)
    sendOrder.mockImplementation(async () => {
      const progress = input.onProgress.mock.calls.at(-1)?.[0]
      return progress.orderId
    })
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'funded', plan: makePlan() },
    })
    expect(result).toMatchObject({
      error: {
        cause:
          'The authorization, Shed balance, or registration price changed.',
        cowShedAccount: SHED,
      },
    })
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(uploadAppData).not.toHaveBeenCalled()
    expect(sendOrder).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('rechecks live readiness before reposting a missing saved publication', async () => {
    const input = makeInput()
    mockReadiness(input, false)
    const request = makeRequest()
    const orderId = getCowShedOrderUid(request)
    getOrder
      .mockRejectedValueOnce(
        new OrderBookApiError(new Response('', { status: 404 }), {
          errorType: 'OrderNotFound',
        }),
      )
      .mockResolvedValue({ status: 'fulfilled' })
    sendOrder.mockResolvedValue(orderId)
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'publishing', plan: makePlan(), request, orderId },
    })
    expect(result).toMatchObject({
      error: {
        cause:
          'The authorization, Shed balance, or registration price changed.',
      },
    })
    expect(sendOrder).not.toHaveBeenCalled()
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('reposts only the exact saved reveal request after a missing publication and handles duplicate acknowledgement', async () => {
    const input = makeInput()
    const read = mockReadiness(input, true)
    const request = makeRequest()
    const orderId = getCowShedOrderUid(request)
    getOrder
      .mockRejectedValueOnce(
        new OrderBookApiError(new Response('', { status: 404 }), {
          errorType: 'OrderNotFound',
        }),
      )
      .mockResolvedValueOnce({ status: 'fulfilled' })
    sendOrder.mockRejectedValueOnce(
      new OrderBookApiError(new Response('', { status: 400 }), {
        errorType: 'DuplicatedOrder',
      }),
    )
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'publishing', plan: makePlan(), request, orderId },
    })
    expect(result).toMatchObject({ value: { cowShedAccount: SHED, orderId } })
    expect(sendOrder).toHaveBeenCalledExactlyOnceWith(request)
    expect(read).not.toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'getTradeableOrderWithSignature',
      }),
    )
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each([
    { duration: 1n },
    { resolver: SHED },
    { commitment: `0x${'33'.repeat(32)}` as Hash },
    { registrationPrice: 1n },
    { executionBudget: 1n },
    { maximumSell: 1n },
    { firstOrderValidTo: 1_301 },
    { sellToken: { ...sellToken, address: SHED } },
  ])(
    'rejects saved progress from different checkout terms %o',
    async (change) => {
      const result = await runCowShedRegistrationActor({
        ...makeInput(),
        ...change,
        progress: { stage: 'settled', plan: makePlan() },
      })
      expect(result.isErr()).toBe(true)
    },
  )

  it('refuses recovery with a different connected wallet', async () => {
    const input = makeInput()
    const walletClient = createWalletClient({
      account: SHED,
      chain: sepolia,
      transport: custom({ request: vi.fn() }),
    })
    const result = await runCowShedRegistrationActor({
      ...input,
      walletClient,
      progress: { stage: 'settled', plan: makePlan() },
    })
    expect(result.isErr()).toBe(true)
  })

  it('signs a setup when the registrar minimum age exceeds two minutes', async () => {
    const input = makeInput()
    vi.spyOn(input.publicClient, 'readContract').mockImplementation(
      async ({ functionName }) => {
        if (functionName === 'MIN_COMMITMENT_AGE') return 300n
        if (functionName === 'singleOrders') return false
        throw new Error(`Unexpected read: ${functionName}`)
      },
    )
    vi.spyOn(input.publicClient, 'getCode').mockResolvedValue(undefined)
    const sign = vi
      .spyOn(input.walletClient, 'signTypedData')
      .mockResolvedValue(`0x${'11'.repeat(65)}`)
    const cause = new Error('Setup reverted')
    vi.spyOn(input.publicClient, 'call').mockRejectedValue(cause)
    const result = await runCowShedRegistrationActor(input)
    expect(result).toMatchObject({ error: { cause } })
    expect(sign).toHaveBeenCalledTimes(2)
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'prepared' }),
    )
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each(['registrationHook', 'setupHook'] as const)(
    'does not complete or save a rejected %s signature',
    async (action) => {
      const input = makeInput()
      const cause = new Error('Signature declined')
      const onWalletProgress = vi.fn()
      vi.spyOn(input.publicClient, 'getCode').mockResolvedValue(undefined)
      const sign = vi
        .spyOn(input.walletClient, 'signTypedData')
        .mockRejectedValue(cause)
      if (action === 'setupHook')
        sign.mockResolvedValueOnce(`0x${'11'.repeat(65)}`)
      const result = await runCowShedRegistrationActor({
        ...input,
        onWalletProgress,
      })
      expect(result).toMatchObject({ error: { cause } })
      expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual(
        [
          ...(action === 'setupHook'
            ? [
                { action: 'registrationHook', phase: 'awaitingSignature' },
                { action: 'registrationHook', phase: 'completed' },
              ]
            : []),
          { action, phase: 'awaitingSignature' },
        ],
      )
      expect(input.onProgress).not.toHaveBeenCalled()
      expect(getQuoteOnly).not.toHaveBeenCalled()
    },
  )

  it('reports the two hook signatures separately without saving transient progress', async () => {
    const input = makeInput()
    vi.spyOn(input.publicClient, 'readContract').mockImplementation(
      async ({ functionName }) => {
        if (functionName === 'MIN_COMMITMENT_AGE') return 120n
        if (functionName === 'singleOrders') return false
        throw new Error(`Unexpected read: ${functionName}`)
      },
    )
    vi.spyOn(input.publicClient, 'getCode').mockResolvedValue(undefined)
    const onWalletProgress = vi.fn()
    const sign = vi
      .spyOn(input.walletClient, 'signTypedData')
      .mockImplementation(async () => {
        expect(onWalletProgress).toHaveBeenLastCalledWith({
          action:
            sign.mock.calls.length === 1 ? 'registrationHook' : 'setupHook',
          phase: 'awaitingSignature',
        })
        return `0x${'11'.repeat(65)}`
      })
    vi.spyOn(input.publicClient, 'call').mockRejectedValue(
      new Error('Stop after signing'),
    )
    const result = await runCowShedRegistrationActor({
      ...input,
      onWalletProgress,
    })
    expect(result.isErr()).toBe(true)
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'registrationHook', phase: 'awaitingSignature' },
      { action: 'registrationHook', phase: 'completed' },
      { action: 'setupHook', phase: 'awaitingSignature' },
      { action: 'setupHook', phase: 'completed' },
    ])
    expect(input.onProgress).toHaveBeenCalledTimes(1)
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'prepared' }),
    )
  })

  it('preflights a newly signed setup without reading roots after saving its plan and before any purchase', async () => {
    const input = makeInput()
    const read = vi
      .spyOn(input.publicClient, 'readContract')
      .mockImplementation(async ({ functionName }) => {
        if (functionName === 'MIN_COMMITMENT_AGE') return 120n
        if (functionName === 'singleOrders') return false
        throw new Error(`Unexpected read: ${functionName}`)
      })
    vi.spyOn(input.publicClient, 'getCode').mockResolvedValue(undefined)
    const sign = vi
      .spyOn(input.walletClient, 'signTypedData')
      .mockResolvedValue(`0x${'11'.repeat(65)}`)
    const cause = new Error('Fresh setup reverted')
    const preflight = vi
      .spyOn(input.publicClient, 'call')
      .mockImplementation(async () => {
        expect(input.onProgress).toHaveBeenCalledTimes(1)
        expect(input.onProgress).toHaveBeenCalledWith(
          expect.objectContaining({ stage: 'prepared' }),
        )
        throw cause
      })
    const result = await runCowShedRegistrationActor(input)
    const saved = input.onProgress.mock.calls[0]?.[0]
    expect(read).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'roots' }),
    )
    expect(sign).toHaveBeenCalledTimes(2)
    expect(preflight).toHaveBeenCalledExactlyOnceWith({
      account: OWNER,
      to: saved?.plan.signed.setupHook.target,
      data: saved?.plan.signed.setupHook.callData,
      gas: 3_000_000n,
    })
    expect(result).toMatchObject({ error: { cause } })
    expect(input.onProgress).toHaveBeenCalledTimes(1)
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('keeps a prepared plan recoverable when its exact saved setup call fails preflight', async () => {
    const input = makeInput()
    const saved = makePlan()
    const plan = {
      ...saved,
      signed: {
        ...saved.signed,
        setupHook: {
          target: OWNER,
          callData: '0x1234' as const,
          gasLimit: 987_654,
        },
      },
    }
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    const cause = new Error('Setup reverted')
    const preflight = vi
      .spyOn(input.publicClient, 'call')
      .mockRejectedValue(cause)
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan },
    })
    expect(preflight).toHaveBeenCalledExactlyOnceWith({
      account: OWNER,
      to: OWNER,
      data: '0x1234',
      gas: 987_654n,
    })
    expect(result).toMatchObject({ error: { cause, cowShedAccount: SHED } })
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('does not mark funding submission when aborted during setup preflight', async () => {
    const input = makeInput()
    const controller = new AbortController()
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    vi.spyOn(input.publicClient, 'call').mockImplementation(async () => {
      controller.abort(new Error('Checkout stopped'))
      return { data: '0x' }
    })
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan: makePlan() },
      signal: controller.signal,
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr())
      expect(result.error.message).not.toContain('needs recovery')
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(getQuoteOnly).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('can preflight the saved funding authorization at its expiry timestamp', async () => {
    const input = makeInput()
    vi.spyOn(input.publicClient, 'getBlock').mockResolvedValue({
      timestamp: 1_300n,
    } as Awaited<ReturnType<typeof input.publicClient.getBlock>>)
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    const cause = new Error('Setup reverted')
    const preflight = vi
      .spyOn(input.publicClient, 'call')
      .mockRejectedValue(cause)
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan: makePlan() },
    })
    expect(result).toMatchObject({ error: { cause } })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('does not start funding when the first authorization expired', async () => {
    const timestamp = 1_301n
    const input = makeInput()
    vi.spyOn(input.publicClient, 'getBlock').mockResolvedValue({
      timestamp,
    } as Awaited<ReturnType<typeof input.publicClient.getBlock>>)
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    const preflight = vi.spyOn(input.publicClient, 'call')
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan: makePlan() },
    })
    expect(result.isErr()).toBe(true)
    expect(preflight).not.toHaveBeenCalled()
    expect(input.onProgress).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each([
    {
      reason: 'the actual minimum commitment age',
      timestamp: 1_500n,
      committedAt: 1_400n,
      minAge: 200n,
    },
  ])(
    'waits for $reason and supports abort without another purchase',
    async ({ timestamp, committedAt, minAge }) => {
      const input = makeInput()
      const controller = new AbortController()
      const getBlock = vi
        .spyOn(input.publicClient, 'getBlock')
        .mockResolvedValue({ timestamp } as Awaited<
          ReturnType<typeof input.publicClient.getBlock>
        >)
      vi.spyOn(input.publicClient, 'readContract')
        .mockResolvedValueOnce(committedAt)
        .mockResolvedValueOnce(minAge)
        .mockResolvedValueOnce(86_400n)
      const pending = runCowShedRegistrationActor({
        ...input,
        progress: { stage: 'funded', plan: makePlan() },
        signal: controller.signal,
      })
      await vi.waitFor(() => expect(getBlock).toHaveBeenCalled())
      controller.abort()
      const result = await pending
      expect(result.isErr()).toBe(true)
      expect(uploadAppData).not.toHaveBeenCalled()
      expect(sendOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )

  it('resumes an ambiguous second publication by its deterministic uid without another submission', async () => {
    const input = makeInput()
    const request = makeRequest()
    const orderId = getCowShedOrderUid(request)
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'publishing', plan: makePlan(), request, orderId },
    })
    expect(result).toMatchObject({ value: { orderId, cowShedAccount: SHED } })
    expect(getOrder).toHaveBeenCalledWith(orderId)
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'settled', orderId }),
    )
    expect(sendOrder).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each([
    { reason: 'funds missing', balance: 5_999_999n, price: 5_000_000n },
    { reason: 'price increased', balance: 6_000_000n, price: 5_000_001n },
  ])(
    'does not publish or repurchase when $reason',
    async ({ balance, price }) => {
      const input = makeInput()
      const plan = makePlan()
      vi.spyOn(input.publicClient, 'getBlock').mockResolvedValue({
        timestamp: 1_500n,
      } as Awaited<ReturnType<typeof input.publicClient.getBlock>>)
      vi.spyOn(input.publicClient, 'readContract')
        .mockResolvedValueOnce(1_100n)
        .mockResolvedValueOnce(120n)
        .mockResolvedValueOnce(86_400n)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(balance)
        .mockResolvedValueOnce([price, 0n])
      const result = await runCowShedRegistrationActor({
        ...input,
        progress: { stage: 'funded', plan },
      })
      expect(result.isErr()).toBe(true)
      expect(input.onProgress).not.toHaveBeenCalled()
      expect(uploadAppData).not.toHaveBeenCalled()
      expect(sendOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )

  it('funds a single order once, persists both submission boundaries, and completes only after the reveal fills', async () => {
    const input = makeInput()
    const plan = makePlan()
    const preflight = vi
      .spyOn(input.publicClient, 'call')
      .mockImplementation(async () => {
        expect(input.onProgress).not.toHaveBeenCalled()
        return { data: '0x' }
      })
    const quote = {
      orderToSign: { sellAmount: '1000000000000000000', validTo: 1_300 },
    }
    getQuoteOnly.mockResolvedValue(quote)
    getQuote.mockResolvedValue({
      quoteResults: quote,
      postSwapOrderFromQuote,
    })
    postSwapOrderFromQuote.mockImplementation(async () => {
      expect(input.onProgress).toHaveBeenCalledWith({
        stage: 'fundingSubmission',
        plan,
      })
      return { orderId: 'first-order' }
    })
    uploadAppData.mockResolvedValue({})
    sendOrder.mockImplementation(async () => {
      const progress = input.onProgress.mock.calls.at(-1)?.[0]
      expect(progress.stage).toBe('publishing')
      return progress.orderId
    })
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    vi.spyOn(input.publicClient, 'getBlock')
      .mockResolvedValueOnce({ timestamp: 1_000n } as Awaited<
        ReturnType<typeof input.publicClient.getBlock>
      >)
      .mockResolvedValue({ timestamp: 1_500n } as Awaited<
        ReturnType<typeof input.publicClient.getBlock>
      >)
    vi.spyOn(input.publicClient, 'readContract')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(1_100n)
      .mockResolvedValueOnce(120n)
      .mockResolvedValueOnce(86_400n)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(6_000_000n)
      .mockResolvedValueOnce([5_000_000n, 0n])
      .mockResolvedValueOnce(makeTradeableOrder())
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan },
    })
    expect(result.isOk()).toBe(true)
    expect(
      input.onProgress.mock.calls.map(([progress]) => progress.stage),
    ).toEqual([
      'fundingSubmission',
      'fundingSent',
      'funded',
      'publishing',
      'revealSent',
      'settled',
    ])
    expect(postSwapOrderFromQuote).toHaveBeenCalledTimes(1)
    expect(preflight).toHaveBeenCalledExactlyOnceWith({
      account: OWNER,
      to: plan.signed.setupHook.target,
      data: plan.signed.setupHook.callData,
      gas: 1_000_000n,
    })
    expect(uploadAppData).toHaveBeenCalledWith(HASH, '{}')
    expect(sendOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        buyAmount: '1',
        sellAmount: '1000000',
        from: SHED,
      }),
    )
  })

  it('submits the refreshed funding quote above checkout and saves its order', async () => {
    const input = makeInput()
    const plan = makePlan()
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    vi.spyOn(input.publicClient, 'call').mockResolvedValue({ data: '0x' })
    const quote = {
      orderToSign: { sellAmount: '1000000000000000001', validTo: 1_300 },
    }
    getQuoteOnly.mockResolvedValue(quote)
    getQuote.mockResolvedValue({ quoteResults: quote, postSwapOrderFromQuote })
    postSwapOrderFromQuote.mockImplementation(async () => {
      expect(input.onProgress).toHaveBeenCalledExactlyOnceWith({
        stage: 'fundingSubmission',
        plan,
      })
      return { orderId: 'refreshed-order' }
    })
    getOrder.mockResolvedValue({ status: 'expired' })
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.message).toContain('is expired')
    const funding = {
      orderId: 'refreshed-order',
      kind: 'erc20',
      validTo: 1_300,
      amountOut: 6_000_000n,
    } as const
    expect(input.onProgress).toHaveBeenLastCalledWith({
      stage: 'fundingSent',
      plan: { ...plan, funding },
      funding,
    })
    expect(postSwapOrderFromQuote).toHaveBeenCalledTimes(1)
  })

  it('keeps an uncertain submission in recovery and does not purchase again on retry', async () => {
    const input = makeInput()
    const plan = makePlan()
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    vi.spyOn(input.publicClient, 'call').mockResolvedValue({ data: '0x' })
    const quote = {
      orderToSign: { sellAmount: '1000000000000000000', validTo: 1_300 },
    }
    getQuoteOnly.mockResolvedValue(quote)
    getQuote.mockResolvedValue({ quoteResults: quote, postSwapOrderFromQuote })
    postSwapOrderFromQuote.mockRejectedValue(new Error('Response lost'))
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.message).toContain('needs recovery')
    expect(input.onProgress).toHaveBeenCalledExactlyOnceWith({
      stage: 'fundingSubmission',
      plan,
    })
    const retried = await runCowShedRegistrationActor({
      ...input,
      progress: input.onProgress.mock.calls[0]?.[0],
    })
    expect(retried.isErr()).toBe(true)
    if (retried.isErr()) expect(retried.error.message).toContain('ambiguous')
    expect(postSwapOrderFromQuote).toHaveBeenCalledTimes(1)
  })

  it('stops before funding when durable submission progress cannot be saved', async () => {
    const input = makeInput()
    vi.spyOn(input.publicClient, 'call').mockResolvedValue({ data: '0x' })
    input.onProgress.mockRejectedValue(new Error('Storage is full'))
    const quote = {
      orderToSign: { sellAmount: '1000000000000000000', validTo: 1_300 },
    }
    getQuoteOnly.mockResolvedValue(quote)
    getQuote.mockResolvedValue({ quoteResults: quote, postSwapOrderFromQuote })
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(false)
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'prepared', plan: makePlan() },
    })
    expect(result.isErr()).toBe(true)
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'fundingSubmission' }),
    )
    expect(getOrder).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('records funding completion before checking the hook and never purchases again', async () => {
    getOrder.mockResolvedValue({ status: 'fulfilled' })
    const input = makeInput()
    vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(0n)
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: {
        stage: 'fundingSent',
        plan: makePlan(),
        funding: {
          orderId: 'first-order',
          kind: 'erc20',
          validTo: 1_300,
          amountOut: 6_000_000n,
        },
      },
    })
    expect(result.isErr()).toBe(true)
    expect(input.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'funded' }),
    )
    expect(getOrder).toHaveBeenCalledWith('first-order')
  })

  it.each(['funded', 'revealSent', 'publishing'] as const)(
    'confirms a completed %s registration through the manifest registry without setup preflight',
    async (stage) => {
      const input = makeInput()
      const contracts = getDestinationContracts(sepolia.id)
      vi.spyOn(input.publicClient, 'readContract').mockResolvedValue(0n)
      const preflight = vi.spyOn(input.publicClient, 'call')
      feedRead.mockImplementation(async (_client, request) => {
        expect(request.address).toBe(contracts.ethRegistrar)
        expect(request.functionName).toBe('commitmentAt')
        expect(request.args).toEqual([HASH])
        return 0n
      })
      registryMulticall.mockResolvedValue([
        OWNER,
        {
          status: 2,
          expiry: 1_800_000_000n,
          latestOwner: OWNER,
          tokenId: 1n,
          resource: 1n,
        },
        zeroAddress,
      ])
      const request = makeRequest()
      const orderId = getCowShedOrderUid(request)
      getOrder.mockResolvedValue({ status: 'open' })
      if (stage === 'publishing')
        getOrder.mockRejectedValueOnce(
          new OrderBookApiError(new Response('', { status: 404 }), {
            errorType: 'OrderNotFound',
          }),
        )
      const result = await runCowShedRegistrationActor({
        ...input,
        progress: { stage, plan: makePlan(), request, orderId },
      })
      expect(result.isOk()).toBe(true)
      expect(registryMulticall).toHaveBeenCalledWith(
        input.publicClient,
        expect.objectContaining({
          contracts: [
            expect.objectContaining({
              address: contracts.ethRegistry,
              functionName: 'getResolver',
              args: ['alice'],
            }),
            expect.objectContaining({
              address: contracts.ethRegistry,
              functionName: 'getState',
              args: [BigInt(labelhash('alice'))],
            }),
            expect.objectContaining({
              address: contracts.ethRegistry,
              functionName: 'getSubregistry',
              args: ['alice'],
            }),
          ],
        }),
      )
      expect(input.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'settled' }),
      )
      expect(preflight).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      expect(sendOrder).not.toHaveBeenCalled()
    },
  )

  it('refuses a new purchase when the funding submission has no known order id', async () => {
    const input = makeInput()
    const result = await runCowShedRegistrationActor({
      ...input,
      progress: { stage: 'fundingSubmission', plan: makePlan() },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toContain(SHED)
      expect(result.error.message).toContain('No new purchase')
    }
    expect(input.onProgress).not.toHaveBeenCalled()
  })
})
