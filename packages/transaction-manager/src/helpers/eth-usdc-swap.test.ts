import { getDestinationContracts } from '@ens-apps/smart-account'
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  type Hex,
  hashTypedData,
  numberToHex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { sepolia } from 'viem/chains'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CowSellToken,
  CowSwapSubmissionError,
  EthSwapRejectedError,
  EthSwapUnavailableError,
  NATIVE_ETH,
  quoteCowSwap,
  quoteEthSwap,
  refundExpiredEthSwap,
  submitCowSwap,
  submitEthSwap,
  withBps,
} from './eth-usdc-swap'

const {
  getQuoteOnly,
  getQuote,
  getCowProtocolAllowance,
  approveCowProtocol,
  postSwapOrderFromQuote,
  postSellNativeCurrencyOrder,
  getTradeParametersAfterQuote,
  swapParamsToLimitOrderParams,
  onChainCancelOrder,
  waitForTransactionReceipt,
  viemAdapterConstructor,
  getGlobalAdapter,
  getTokenPermitInfo,
  getPermitUtilsInstance,
  getTokenNonce,
  generatePermitHook,
  fetchPermitInfo,
  uploadAppData,
} = vi.hoisted(() => ({
  getQuoteOnly: vi.fn(),
  getQuote: vi.fn(),
  getCowProtocolAllowance: vi.fn(),
  approveCowProtocol: vi.fn(),
  postSwapOrderFromQuote: vi.fn(),
  postSellNativeCurrencyOrder: vi.fn(),
  getTradeParametersAfterQuote: vi.fn(),
  swapParamsToLimitOrderParams: vi.fn(),
  onChainCancelOrder: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  viemAdapterConstructor: vi.fn(),
  getGlobalAdapter: vi.fn(),
  getTokenPermitInfo: vi.fn(),
  getPermitUtilsInstance: vi.fn(),
  getTokenNonce: vi.fn(),
  generatePermitHook: vi.fn(),
  fetchPermitInfo: vi.fn(),
  uploadAppData: vi.fn(),
}))

vi.mock('@cowprotocol/cow-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cowprotocol/cow-sdk')>()),
  TradingSdk: class {
    getQuoteOnly = getQuoteOnly
    getQuote = getQuote
    getCowProtocolAllowance = getCowProtocolAllowance
    approveCowProtocol = approveCowProtocol
    onChainCancelOrder = onChainCancelOrder
  },
  OrderBookApi: class {
    readonly context
    readonly uploadAppData = uploadAppData

    constructor(context: unknown) {
      this.context = context
    }
  },
  getTradeParametersAfterQuote,
  swapParamsToLimitOrderParams,
  postSellNativeCurrencyOrder,
  getGlobalAdapter,
}))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  waitForTransactionReceipt,
}))

vi.mock('@cowprotocol/sdk-viem-adapter', () => ({
  ViemAdapter: class {
    constructor(options: unknown) {
      viemAdapterConstructor(options)
    }
  },
}))

vi.mock('@cowprotocol/permit-utils', () => ({
  generatePermitHook,
  getPermitUtilsInstance,
  getTokenPermitInfo,
  isSupportedPermitInfo: (value: { type?: string }) =>
    value.type === 'eip-2612' || value.type === 'dai-like',
}))

const WALLET: Address = '0x1111111111111111111111111111111111111111'
const HCA: Address = '0x2222222222222222222222222222222222222222'
const HASH = `0x${'ab'.repeat(32)}` as const
const APPROVAL_HASH = `0x${'cd'.repeat(32)}` as const
const HOOK_TARGET: Address = '0x3333333333333333333333333333333333333333'
const hooks = {
  pre: [
    { target: HOOK_TARGET, callData: '0x1234' as const, gasLimit: 100_000 },
  ],
  post: [{ target: HCA, callData: '0xabcd' as const, gasLimit: 200_000 }],
}
const USDC = getDestinationContracts(sepolia.id).usdc
const WETH: Address = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'
const ETH_FLOW: Address = '0xba3cb449bd2b4adddbc894d8697f5170800eadec'

// EthFlow hashes a GPv2 SELL order with unlimited settlement validity.
const ethFlowUid = (
  order: Readonly<{
    buyToken: Address
    receiver: Address
    sellAmount: bigint
    buyAmount: bigint
    appData: Hex
    feeAmount: bigint
    partiallyFillable: boolean
  }>,
  owner: Address,
) =>
  concat([
    hashTypedData({
      domain: {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: sepolia.id,
        verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
      },
      types: {
        Order: [
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'kind', type: 'string' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'sellTokenBalance', type: 'string' },
          { name: 'buyTokenBalance', type: 'string' },
        ],
      },
      primaryType: 'Order',
      message: {
        ...order,
        sellToken: WETH,
        validTo: 0xffffffff,
        kind: 'sell',
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
      },
    }),
    owner.toLowerCase() as Address,
    numberToHex(0xffffffff, { size: 4 }),
  ])

const DAI: CowSellToken = {
  address: '0x68194a729C2450ad26072b3D33ADaCbcef39D574',
  symbol: 'DAI',
  decimals: 18,
  isNative: false,
}
const USDT: CowSellToken = { ...DAI, symbol: 'USDT' }
const publicClient = { chain: sepolia } as unknown as PublicClient
const walletClient = {
  account: { address: WALLET },
} as unknown as WalletClient

const quoteResult = {
  orderToSign: {
    sellAmount: '10500000000000000',
    validTo: 1_800_000_000,
  },
  tradeParameters: { kind: 'buy' },
  quoteResponse: { id: 42, quote: { feeAmount: '0' } },
  appDataInfo: { fullAppData: '{}', appDataKeccak256: `0x${'00'.repeat(32)}` },
}

const nativeOrderToSign = {
  sellToken: WETH,
  buyToken: USDC,
  receiver: HCA,
  sellAmount: quoteResult.orderToSign.sellAmount,
  buyAmount: '20000000',
  validTo: quoteResult.orderToSign.validTo,
  appData: quoteResult.appDataInfo.appDataKeccak256,
  feeAmount: '0',
  kind: 'buy',
  partiallyFillable: false,
  sellTokenBalance: 'erc20',
  buyTokenBalance: 'erc20',
}
const NATIVE_ORDER_ID = ethFlowUid(
  {
    ...nativeOrderToSign,
    sellAmount: BigInt(nativeOrderToSign.sellAmount),
    buyAmount: BigInt(nativeOrderToSign.buyAmount),
    feeAmount: 0n,
    appData: nativeOrderToSign.appData as Hex,
  },
  ETH_FLOW,
)

beforeEach(async () => {
  vi.clearAllMocks()
  const sdk = await vi.importActual<typeof import('@cowprotocol/cow-sdk')>(
    '@cowprotocol/cow-sdk',
  )
  const { ViemAdapter } = await vi.importActual<
    typeof import('@cowprotocol/sdk-viem-adapter')
  >('@cowprotocol/sdk-viem-adapter')
  const provider = createPublicClient({
    chain: sepolia,
    transport: custom({
      request: async () => {
        throw new Error('Unexpected RPC request during local hashing')
      },
    }),
  })
  vi.spyOn(sdk.AdapterContext.getInstance(), 'getAdapter').mockReturnValue(
    new ViemAdapter({ provider }),
  )
  getTradeParametersAfterQuote.mockReturnValue({ quoted: true })
  swapParamsToLimitOrderParams.mockReturnValue({ limit: true })
  uploadAppData.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetchPermitInfo)
  fetchPermitInfo.mockResolvedValue({
    ok: true,
    json: async () => ({}),
  })
  getGlobalAdapter.mockImplementation(() => {
    throw new Error('Provider adapter is not configured')
  })
  getQuoteOnly.mockResolvedValue(quoteResult)
  postSwapOrderFromQuote.mockResolvedValue({ orderId: 'erc20-order-id' })
  getQuote.mockResolvedValue({
    quoteResults: quoteResult,
    postSwapOrderFromQuote,
  })
  getCowProtocolAllowance.mockResolvedValue(0n)
  getTokenPermitInfo.mockResolvedValue({ type: 'unsupported' })
  getTokenNonce.mockResolvedValue(0)
  getPermitUtilsInstance.mockResolvedValue({ getTokenNonce })
  generatePermitHook.mockResolvedValue({
    target: DAI.address,
    callData: '0xd505accf',
    gasLimit: '160000',
  })
  approveCowProtocol.mockResolvedValue(APPROVAL_HASH)
  waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  postSellNativeCurrencyOrder.mockResolvedValue({
    orderId: 'cow-order-id',
    txHash: HASH,
    orderToSign: nativeOrderToSign,
  })
  onChainCancelOrder.mockResolvedValue(HASH)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CoW ETH funding', () => {
  it.each([
    { protocolFeeBps: undefined, maximumSell: 11_435n },
    { protocolFeeBps: '100', maximumSell: 11_433n },
  ])(
    'funds the checked native order with network costs and protocol fee $protocolFeeBps',
    async ({ protocolFeeBps, maximumSell }) => {
      const sdk = await vi.importActual<typeof import('@cowprotocol/cow-sdk')>(
        '@cowprotocol/cow-sdk',
      )
      const { ViemAdapter } = await vi.importActual<
        typeof import('@cowprotocol/sdk-viem-adapter')
      >('@cowprotocol/sdk-viem-adapter')
      const rpc = vi.fn(async ({ method }: { readonly method: string }) => {
        if (method === 'eth_estimateGas') return '0x249f0'
        throw new Error(`Unexpected RPC request: ${method}`)
      })
      const provider = createPublicClient({
        chain: sepolia,
        transport: custom({ request: rpc }),
      })
      const wallet = createWalletClient({
        account: WALLET,
        chain: sepolia,
        transport: custom({ request: rpc }),
      })
      const sendTransaction = vi
        .spyOn(wallet, 'sendTransaction')
        .mockResolvedValue(HASH)
      vi.spyOn(sdk.AdapterContext.getInstance(), 'getAdapter').mockReturnValue(
        new ViemAdapter({ provider, walletClient: wallet }),
      )
      getTradeParametersAfterQuote.mockImplementationOnce(
        sdk.getTradeParametersAfterQuote,
      )
      swapParamsToLimitOrderParams.mockImplementationOnce(
        sdk.swapParamsToLimitOrderParams,
      )
      postSellNativeCurrencyOrder.mockImplementationOnce(
        sdk.postSellNativeCurrencyOrder,
      )
      getQuoteOnly.mockResolvedValueOnce({
        ...quoteResult,
        orderToSign: {
          ...quoteResult.orderToSign,
          sellAmount: maximumSell.toString(),
        },
        tradeParameters: {
          chainId: sepolia.id,
          kind: sdk.OrderKind.BUY,
          sellToken: sdk.ETH_ADDRESS,
          buyToken: USDC,
          receiver: HCA,
          amount: '20000000',
          validTo: 1_800_000_000,
          slippageBps: 200,
          // A partner fee makes protocol-fee parity visible in the sell amount.
          partnerFee: { volumeBps: 100 },
        },
        quoteResponse: {
          id: 42,
          protocolFeeBps,
          quote: {
            sellAmount: '10100',
            buyAmount: '20000000',
            feeAmount: '1010',
          },
        },
      })

      const onOrderSent = vi.fn().mockResolvedValue(undefined)
      const result = await submitCowSwap({
        onOrderSent,
        publicClient: provider,
        walletClient: wallet,
        chainId: sepolia.id,
        owner: WALLET,
        receiver: HCA,
        amountOut: 20_000_000n,
        sellToken: NATIVE_ETH,
        maximumSell,
      })

      expect(result._unsafeUnwrap().quote.maximumSell).toBe(maximumSell)
      expect(sendTransaction).toHaveBeenCalledOnce()
      const transaction = sendTransaction.mock.calls[0]?.[0]
      assert(transaction?.data)
      assert(transaction.value !== undefined)
      expect(BigInt(transaction.value)).toBe(maximumSell)
      const decoded = decodeFunctionData({
        abi: sdk.EthFlowAbi,
        data: transaction.data,
      })
      expect(decoded).toMatchObject({
        functionName: 'createOrder',
        args: [
          {
            sellAmount: maximumSell,
            buyAmount: 20_000_000n,
            receiver: HCA,
            validTo: 1_800_000_000,
          },
        ],
      })
      assert(decoded.functionName === 'createOrder')
      assert(transaction.to)
      const expectedId = ethFlowUid(decoded.args[0], transaction.to)
      expect(result._unsafeUnwrap().order).toEqual({
        orderId: expectedId,
        hash: HASH,
        validTo: 1_800_000_000,
        kind: 'native',
        amountOut: 20_000_000n,
      })
      expect(onOrderSent).toHaveBeenCalledExactlyOnceWith(
        result._unsafeUnwrap().order,
      )
    },
  )

  it('quotes an exact USDC buy with the HCA as receiver on Sepolia', async () => {
    const result = await quoteEthSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
    })

    expect(result._unsafeUnwrap()).toEqual({
      amountOut: 20_000_000n,
      maximumEth: 10_500_000_000_000_000n,
      maximumSell: 10_500_000_000_000_000n,
      validTo: 1_800_000_000,
    })
    expect(getQuoteOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'buy',
        sellToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        buyToken: USDC,
        amount: '20000000',
        owner: WALLET,
        receiver: HCA,
      }),
    )
  })

  it('submits the quoted EthFlow order and returns its recovery handle', async () => {
    const result = await submitEthSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      maximumEth: 11_000_000_000_000_000n,
    })

    expect(result._unsafeUnwrap().order).toEqual({
      orderId: NATIVE_ORDER_ID,
      hash: HASH,
      validTo: 1_800_000_000,
      kind: 'native',
      amountOut: 20_000_000n,
    })
    expect(postSellNativeCurrencyOrder).toHaveBeenCalledOnce()
  })

  it('does not call EthFlow when the refreshed quote crosses the hard ceiling', async () => {
    const result = await submitEthSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      maximumEth: 10_000_000_000_000_000n,
    })

    expect(result.isErr()).toBe(true)
    expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
  })

  it('supports only the ENS mainnet and Sepolia deployments', async () => {
    const result = await quoteEthSwap({
      publicClient,
      chainId: 10,
      owner: WALLET,
      receiver: HCA,
      amountOut: 1n,
    })
    expect(result.isErr()).toBe(true)
    expect(getQuoteOnly).not.toHaveBeenCalled()
  })

  it('uses the SDK on-chain cancellation to refund an expired EthFlow order', async () => {
    const order = { uid: 'cow-order-id' }
    const result = await refundExpiredEthSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      order: order as never,
    })

    expect(result._unsafeUnwrap()).toBe(HASH)
    expect(onChainCancelOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderUid: 'cow-order-id',
        chainId: sepolia.id,
      }),
      order,
    )
  })
})

describe('CoW submission checkpoint', () => {
  it.each([NATIVE_ETH, DAI])(
    'returns a recovery error without posting $symbol if the checkpoint fails',
    async (sellToken) => {
      const cause = new Error('storage failed')
      const result = await run({
        sellToken,
        onBeforeOrderSubmission: () => Promise.reject(cause),
      })
      const error = result._unsafeUnwrapErr()
      expect(error).toBeInstanceOf(CowSwapSubmissionError)
      expect(error).toBeInstanceOf(EthSwapUnavailableError)
      expect(error).toMatchObject({ _tag: 'EthSwapUnavailableError', cause })
      expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )

  it.each([NATIVE_ETH, DAI])(
    'does not post $symbol after cancellation during the checkpoint',
    async (sellToken) => {
      const controller = new AbortController()
      const checkpoint = Promise.withResolvers<void>()
      const onBeforeOrderSubmission = vi.fn(() => checkpoint.promise)
      const pending = run({
        sellToken,
        signal: controller.signal,
        onBeforeOrderSubmission,
      })
      await vi.waitFor(() =>
        expect(onBeforeOrderSubmission).toHaveBeenCalledOnce(),
      )
      controller.abort()
      checkpoint.resolve()
      const error = (await pending)._unsafeUnwrapErr()
      expect(error).toBeInstanceOf(CowSwapSubmissionError)
      expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )

  it.each([NATIVE_ETH, DAI])(
    'classifies $symbol SDK post failures as recovery errors',
    async (sellToken) => {
      const cause = new Error('submission response lost')
      const post = sellToken.isNative
        ? postSellNativeCurrencyOrder
        : postSwapOrderFromQuote
      post.mockRejectedValueOnce(cause)
      const result = await run({ sellToken })
      const error = result._unsafeUnwrapErr()
      expect(error).toBeInstanceOf(CowSwapSubmissionError)
      expect(error).toMatchObject({ cause, _tag: 'EthSwapUnavailableError' })
    },
  )

  it('requires recovery without retrying when native UID hashing fails after submission', async () => {
    const sdk = await vi.importActual<typeof import('@cowprotocol/cow-sdk')>(
      '@cowprotocol/cow-sdk',
    )
    const cause = new Error('local hashing failed')
    vi.spyOn(
      sdk.AdapterContext.getInstance().getAdapter().utils,
      'hashTypedData',
    ).mockImplementationOnce(() => {
      throw cause
    })
    const onBeforeOrderSubmission = vi.fn().mockResolvedValue(undefined)
    const onOrderSent = vi.fn().mockResolvedValue(undefined)

    const result = await run({
      sellToken: NATIVE_ETH,
      onBeforeOrderSubmission,
      onOrderSent,
    })

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(CowSwapSubmissionError)
    expect(result._unsafeUnwrapErr()).toMatchObject({ cause })
    expect(onBeforeOrderSubmission).toHaveBeenCalledOnce()
    expect(postSellNativeCurrencyOrder).toHaveBeenCalledOnce()
    expect(onOrderSent).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    expect(getQuoteOnly).toHaveBeenCalledOnce()
    expect(getQuote).not.toHaveBeenCalled()
    expect(approveCowProtocol).not.toHaveBeenCalled()
  })

  it('requires recovery when EthFlow returns no transaction hash', async () => {
    postSellNativeCurrencyOrder.mockResolvedValueOnce({
      orderId: 'native-without-hash',
      orderToSign: nativeOrderToSign,
    })
    const result = await run({ sellToken: NATIVE_ETH })
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(CowSwapSubmissionError)
  })

  it.each([NATIVE_ETH, DAI])(
    'requires recovery if the posted $symbol order cannot be saved',
    async (sellToken) => {
      const cause = new Error('order storage failed')
      const onOrderSent = vi.fn(() => Promise.reject(cause))
      const result = await run({ sellToken, onOrderSent })
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CowSwapSubmissionError)
      expect(result._unsafeUnwrapErr()).toMatchObject({ cause })
      expect(onOrderSent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          orderId: sellToken.isNative ? NATIVE_ORDER_ID : 'erc20-order-id',
          kind: sellToken.isNative ? 'native' : 'erc20',
        }),
      )
    },
  )

  it.each([
    {
      boundary: 'initial price guard',
      setup: () => ({}),
      overrides: { maximumSell: 1n },
    },
    {
      boundary: 'expiry guard',
      setup: () => ({}),
      overrides: { fixedValidTo: 1_799_999_999 },
    },
    {
      boundary: 'final price guard',
      setup: () =>
        getQuote.mockResolvedValueOnce({
          quoteResults: {
            ...quoteResult,
            orderToSign: {
              ...quoteResult.orderToSign,
              sellAmount: '12000000000000000',
            },
          },
          postSwapOrderFromQuote,
        }),
      overrides: {},
    },
    {
      boundary: 'order preparation failure',
      setup: () => getQuote.mockRejectedValueOnce(new Error('quote failed')),
      overrides: {},
    },
    {
      boundary: 'approval failure',
      setup: () =>
        approveCowProtocol.mockRejectedValueOnce(new Error('approval failed')),
      overrides: {},
    },
    {
      boundary: 'cancellation before checkpoint',
      setup: () => ({}),
      overrides: { signal: AbortSignal.abort() },
    },
  ])('does not checkpoint after $boundary', async ({ setup, overrides }) => {
    setup()
    const onBeforeOrderSubmission = vi.fn().mockResolvedValue(undefined)
    const result = await run({ ...overrides, onBeforeOrderSubmission })
    expect(result._unsafeUnwrapErr()).not.toBeInstanceOf(CowSwapSubmissionError)
    expect(onBeforeOrderSubmission).not.toHaveBeenCalled()
    expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it.each([NATIVE_ETH, DAI])(
    'returns a recovery Result if the $symbol SDK throws synchronously',
    async (sellToken) => {
      const cause = new Error('SDK failed synchronously')
      const post = sellToken.isNative
        ? postSellNativeCurrencyOrder
        : postSwapOrderFromQuote
      post.mockImplementationOnce(() => {
        throw cause
      })
      const result = await run({ sellToken })
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CowSwapSubmissionError)
      expect(result._unsafeUnwrapErr()).toMatchObject({ cause })
    },
  )

  it.each([NATIVE_ETH, DAI])(
    'returns a recovery Result if saving the $symbol order throws synchronously',
    async (sellToken) => {
      const cause = new Error('storage failed synchronously')
      const result = await run({
        sellToken,
        onOrderSent: () => {
          throw cause
        },
      })
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CowSwapSubmissionError)
      expect(result._unsafeUnwrapErr()).toMatchObject({ cause })
    },
  )

  const run = (overrides: Partial<Parameters<typeof submitCowSwap>[0]> = {}) =>
    submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      ...overrides,
    })

  it.each([NATIVE_ETH, DAI])(
    'waits for the durable checkpoint before posting $symbol',
    async (sellToken) => {
      const checkpoint = Promise.withResolvers<void>()
      const onBeforeOrderSubmission = vi.fn(() => checkpoint.promise)
      const pending = run({ sellToken, onBeforeOrderSubmission })
      await vi.waitFor(() =>
        expect(onBeforeOrderSubmission).toHaveBeenCalledOnce(),
      )
      expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()

      checkpoint.resolve()
      expect((await pending).isOk()).toBe(true)
      expect(
        sellToken.isNative
          ? postSellNativeCurrencyOrder
          : postSwapOrderFromQuote,
      ).toHaveBeenCalledOnce()
    },
  )
})

describe('CoW latest-quote funding', () => {
  const run = (overrides: Partial<Parameters<typeof submitCowSwap>[0]> = {}) =>
    submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 1n,
      priceLimit: 'latestQuote',
      ...overrides,
    })

  it.each([NATIVE_ETH, DAI])(
    'submits $symbol above the checkout maximum when the latest quote is selected',
    async (sellToken) => {
      const result = await run({ sellToken })
      expect(result._unsafeUnwrap().quote.maximumSell).toBe(
        10_500_000_000_000_000n,
      )
      expect(
        sellToken.isNative
          ? postSellNativeCurrencyOrder
          : postSwapOrderFromQuote,
      ).toHaveBeenCalledOnce()
    },
  )
  it.each([
    { maximumSell: 1n, hardMaximumSell: false },
    { maximumSell: 100_000_000_000_000_000n, hardMaximumSell: true },
  ])(
    'sizes the permit from the fresh quote when hardMaximumSell is $hardMaximumSell',
    async (overrides) => {
      getTokenPermitInfo.mockResolvedValue({ type: 'eip-2612' })
      const signedPermitQuote = {
        ...quoteResult,
        orderToSign: {
          ...quoteResult.orderToSign,
          sellAmount: '14000000000000000',
        },
      }
      getQuoteOnly
        .mockResolvedValueOnce(quoteResult)
        .mockResolvedValueOnce(signedPermitQuote)
      getQuote.mockResolvedValueOnce({
        quoteResults: signedPermitQuote,
        postSwapOrderFromQuote,
      })

      const result = await run(overrides)
      expect(result._unsafeUnwrap().quote.maximumSell).toBe(
        14_000_000_000_000_000n,
      )
      expect(generatePermitHook).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ amount: 15_750_000_000_000_000n }),
      )
      expect(approveCowProtocol).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
    },
  )
  it.each(['hook', 'final'] as const)(
    'rejects a %s quote above the signed permit without requesting a new permit',
    async (boundary) => {
      getTokenPermitInfo.mockResolvedValue({ type: 'eip-2612' })
      const overrunQuote = {
        ...quoteResult,
        orderToSign: {
          ...quoteResult.orderToSign,
          sellAmount: '15750000000000001',
        },
      }
      getQuoteOnly
        .mockResolvedValueOnce(quoteResult)
        .mockResolvedValueOnce(boundary === 'hook' ? overrunQuote : quoteResult)
      if (boundary === 'final') {
        getQuote.mockResolvedValueOnce({
          quoteResults: overrunQuote,
          postSwapOrderFromQuote,
        })
      }
      const onBeforeOrderSubmission = vi.fn()

      const error = (await run({ onBeforeOrderSubmission }))._unsafeUnwrapErr()
      expect(error).toBeInstanceOf(EthSwapRejectedError)
      expect(error.message).toMatch(/signed.*permit/i)
      expect(generatePermitHook).toHaveBeenCalledOnce()
      expect(approveCowProtocol).not.toHaveBeenCalled()
      expect(onBeforeOrderSubmission).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )
  it('confirms the exact final allowance before checkpointing with latestQuote', async () => {
    getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)
    const finalQuote = {
      ...quoteResult,
      orderToSign: {
        ...quoteResult.orderToSign,
        sellAmount: '12000000000000000',
      },
    }
    getQuote.mockResolvedValueOnce({
      quoteResults: finalQuote,
      postSwapOrderFromQuote,
    })
    const receipt = Promise.withResolvers<{ status: 'success' }>()
    waitForTransactionReceipt.mockReturnValueOnce(receipt.promise)
    const onBeforeOrderSubmission = vi.fn().mockResolvedValue(undefined)
    const onOrderSent = vi.fn().mockResolvedValue(undefined)
    const pending = run({
      onBeforeOrderSubmission,
      onOrderSent,
    })
    await vi.waitFor(() =>
      expect(approveCowProtocol).toHaveBeenCalledExactlyOnceWith({
        tokenAddress: DAI.address,
        amount: 12_000_000_000_000_000n,
      }),
    )
    expect(onBeforeOrderSubmission).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    receipt.resolve({ status: 'success' })

    expect((await pending)._unsafeUnwrap().quote.maximumSell).toBe(
      12_000_000_000_000_000n,
    )
    expect(onBeforeOrderSubmission).toHaveBeenCalledOnce()
    expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
    expect(onOrderSent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: 'erc20-order-id' }),
    )
    expect(getQuoteOnly).toHaveBeenCalledOnce()
    expect(getQuote).toHaveBeenCalledOnce()
    expect(generatePermitHook).not.toHaveBeenCalled()
  })
  it.each(['rejected', 'reverted', 'cancelled'] as const)(
    'does not checkpoint or post when final approval is %s',
    async (outcome) => {
      const controller = new AbortController()
      getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)
      getQuote.mockResolvedValueOnce({
        quoteResults: {
          ...quoteResult,
          orderToSign: {
            ...quoteResult.orderToSign,
            sellAmount: '12000000000000000',
          },
        },
        postSwapOrderFromQuote,
      })
      if (outcome === 'rejected') {
        approveCowProtocol.mockRejectedValueOnce(
          new Error('User rejected approval'),
        )
      } else {
        waitForTransactionReceipt.mockImplementationOnce(async () => {
          if (outcome === 'cancelled') controller.abort()
          return { status: outcome === 'reverted' ? 'reverted' : 'success' }
        })
      }
      const onBeforeOrderSubmission = vi.fn()
      const result = await run({
        signal: controller.signal,
        onBeforeOrderSubmission,
      })
      expect(result._unsafeUnwrapErr()).not.toBeInstanceOf(
        CowSwapSubmissionError,
      )
      expect(approveCowProtocol).toHaveBeenCalledExactlyOnceWith({
        tokenAddress: DAI.address,
        amount: 12_000_000_000_000_000n,
      })
      expect(onBeforeOrderSubmission).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      expect(getQuote).toHaveBeenCalledOnce()
    },
  )

  it('does not approve an increased final quote after cancellation during that quote', async () => {
    const controller = new AbortController()
    getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)
    getQuote.mockImplementationOnce(async () => {
      controller.abort()
      return {
        quoteResults: {
          ...quoteResult,
          orderToSign: {
            ...quoteResult.orderToSign,
            sellAmount: '12000000000000000',
          },
        },
        postSwapOrderFromQuote,
      }
    })
    const onBeforeOrderSubmission = vi.fn()
    const result = await run({
      signal: controller.signal,
      onBeforeOrderSubmission,
    })
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(EthSwapRejectedError)
    expect(approveCowProtocol).not.toHaveBeenCalled()
    expect(onBeforeOrderSubmission).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })
})

describe('CoW funding cancellation', () => {
  it.each([
    'initial quote',
    'permit metadata',
    'permit nonce',
    'final quote',
    'native quote',
  ] as const)(
    'does not start a new wallet request after cancellation during %s',
    async (boundary) => {
      const controller = new AbortController()
      const abortWith =
        <T>(value: T) =>
        async () => {
          controller.abort()
          return value
        }
      if (boundary === 'initial quote' || boundary === 'native quote')
        getQuoteOnly.mockImplementationOnce(abortWith(quoteResult))
      if (boundary === 'permit metadata')
        getTokenPermitInfo.mockImplementationOnce(
          abortWith({ type: 'eip-2612' }),
        )
      if (boundary === 'permit nonce') {
        getTokenPermitInfo.mockResolvedValue({ type: 'eip-2612' })
        getTokenNonce.mockImplementationOnce(abortWith(0))
      }
      if (boundary === 'final quote') {
        getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)
        getQuote.mockImplementationOnce(
          abortWith({ quoteResults: quoteResult, postSwapOrderFromQuote }),
        )
      }
      const result = await submitCowSwap({
        publicClient,
        walletClient,
        chainId: sepolia.id,
        owner: WALLET,
        receiver: HCA,
        amountOut: 20_000_000n,
        sellToken:
          boundary === 'native quote' ? { ...DAI, isNative: true } : DAI,
        maximumSell: 11_000_000_000_000_000n,
        signal: controller.signal,
      })
      expect(result.isErr()).toBe(true)
      expect(generatePermitHook).not.toHaveBeenCalled()
      expect(approveCowProtocol).not.toHaveBeenCalled()
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
      expect(postSellNativeCurrencyOrder).not.toHaveBeenCalled()
    },
  )

  it('does not approve again after cancellation while the zero-first reset confirms', async () => {
    const controller = new AbortController()
    getCowProtocolAllowance.mockResolvedValue(1n)
    waitForTransactionReceipt.mockImplementationOnce(async () => {
      controller.abort()
      return { status: 'success' }
    })
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: USDT,
      maximumSell: 11_000_000_000_000_000n,
      signal: controller.signal,
    })
    expect(result.isErr()).toBe(true)
    expect(approveCowProtocol).toHaveBeenCalledExactlyOnceWith({
      tokenAddress: DAI.address,
      amount: 0n,
    })
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('saves the submitted order even if cancellation occurs inside the wallet submission', async () => {
    const controller = new AbortController()
    const onOrderSent = vi.fn().mockResolvedValue(undefined)
    postSwapOrderFromQuote.mockImplementationOnce(async () => {
      controller.abort()
      return { orderId: 'submitted-before-abort' }
    })
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      signal: controller.signal,
      onOrderSent,
    })
    expect(result.isOk()).toBe(true)
    expect(onOrderSent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: 'submitted-before-abort' }),
    )
  })

  it('does not prompt for an order after cancellation while approval confirms', async () => {
    const controller = new AbortController()
    waitForTransactionReceipt.mockImplementationOnce(async () => {
      controller.abort()
      return { status: 'success' }
    })
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      signal: controller.signal,
    })
    expect(result.isErr()).toBe(true)
    expect(getQuote).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })
})

describe('CoW wallet progress', () => {
  const run = (overrides: Partial<Parameters<typeof submitCowSwap>[0]> = {}) =>
    submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      ...overrides,
    })

  it.each(['resetAllowance', 'tokenApproval'] as const)(
    'does not complete %s when its receipt reverts',
    async (action) => {
      const onWalletProgress = vi.fn()
      getCowProtocolAllowance.mockResolvedValue(
        action === 'resetAllowance' ? 1n : 0n,
      )
      waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' })
      const result = await run({
        sellToken: { ...DAI, symbol: 'USDT' },
        onWalletProgress,
      })
      assert(result.isErr())
      expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual(
        [
          { action, phase: 'awaitingSignature' },
          { action, phase: 'awaitingConfirmation' },
        ],
      )
      expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    },
  )

  it('completes the allowance reset before requesting the replacement approval', async () => {
    const onWalletProgress = vi.fn()
    getCowProtocolAllowance.mockResolvedValue(1n)
    const result = await run({
      sellToken: { ...DAI, symbol: 'USDT' },
      onWalletProgress,
    })
    assert(result.isOk())
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'resetAllowance', phase: 'awaitingSignature' },
      { action: 'resetAllowance', phase: 'awaitingConfirmation' },
      { action: 'resetAllowance', phase: 'completed' },
      { action: 'tokenApproval', phase: 'awaitingSignature' },
      { action: 'tokenApproval', phase: 'awaitingConfirmation' },
      { action: 'tokenApproval', phase: 'completed' },
    ])
  })

  it.each(['tokenPermit', 'paymentOrder'] as const)(
    'keeps %s incomplete when its signature or post fails',
    async (action) => {
      const onWalletProgress = vi.fn()
      const cause = new Error('Wallet operation failed')
      if (action === 'tokenPermit') {
        getTokenPermitInfo.mockResolvedValueOnce({ type: 'eip-2612' })
        generatePermitHook.mockRejectedValueOnce(cause)
      } else {
        getCowProtocolAllowance.mockResolvedValue(10n ** 30n)
        postSwapOrderFromQuote.mockImplementationOnce(
          async (_settings, steps) => {
            steps.beforeOrderSign()
            throw cause
          },
        )
      }
      const result = await run({ onWalletProgress })
      assert(result.isErr())
      expect(result.error).toMatchObject({ cause })
      expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual(
        [{ action, phase: 'awaitingSignature' }],
      )
    },
  )

  it('reports a permit only after token support is known and after the signature succeeds', async () => {
    const onWalletProgress = vi.fn()
    getTokenPermitInfo.mockResolvedValueOnce({ type: 'eip-2612' })
    generatePermitHook.mockImplementationOnce(async () => {
      expect(onWalletProgress).toHaveBeenLastCalledWith({
        action: 'tokenPermit',
        phase: 'awaitingSignature',
      })
      return { target: DAI.address, callData: '0xd505accf', gasLimit: '160000' }
    })
    const result = await run({ onWalletProgress })
    assert(result.isOk())
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'tokenPermit', phase: 'awaitingSignature' },
      { action: 'tokenPermit', phase: 'completed' },
    ])
    expect(approveCowProtocol).not.toHaveBeenCalled()
  })

  it('reports native payment submission without claiming receipt completion', async () => {
    const onWalletProgress = vi.fn()
    postSellNativeCurrencyOrder.mockImplementationOnce(async () => {
      expect(onWalletProgress).toHaveBeenLastCalledWith({
        action: 'nativePayment',
        phase: 'awaitingSignature',
      })
      return { txHash: HASH, orderToSign: nativeOrderToSign }
    })
    const result = await run({ sellToken: NATIVE_ETH, onWalletProgress })
    assert(result.isOk())
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'nativePayment', phase: 'awaitingSignature' },
      { action: 'nativePayment', phase: 'awaitingConfirmation' },
    ])
    expect(waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('keeps approval pending until its receipt succeeds and reports the combined order operation', async () => {
    const onWalletProgress = vi.fn()
    const receipt = Promise.withResolvers<{ status: string }>()
    waitForTransactionReceipt.mockReturnValueOnce(receipt.promise)
    postSwapOrderFromQuote.mockImplementationOnce(async (_settings, steps) => {
      steps.beforeOrderSign()
      expect(onWalletProgress).toHaveBeenLastCalledWith({
        action: 'paymentOrder',
        phase: 'awaitingSignature',
      })
      steps.afterOrderSign()
      return { orderId: 'erc20-order-id' }
    })
    const pending = run({ onWalletProgress })
    await vi.waitFor(() =>
      expect(waitForTransactionReceipt).toHaveBeenCalledOnce(),
    )
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'tokenApproval', phase: 'awaitingSignature' },
      { action: 'tokenApproval', phase: 'awaitingConfirmation' },
    ])
    receipt.resolve({ status: 'success' })
    assert((await pending).isOk())
    expect(onWalletProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { action: 'tokenApproval', phase: 'awaitingSignature' },
      { action: 'tokenApproval', phase: 'awaitingConfirmation' },
      { action: 'tokenApproval', phase: 'completed' },
      { action: 'paymentOrder', phase: 'awaitingSignature' },
      { action: 'paymentOrder', phase: 'completed' },
    ])
    expect(generatePermitHook).not.toHaveBeenCalled()
  })
})

describe('CoW ERC-20 funding', () => {
  it('refuses an order whose expiry outlasts the signed Shed commitment window', async () => {
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      fixedValidTo: 1_799_999_999,
    })
    expect(result.isErr()).toBe(true)
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
    expect(approveCowProtocol).not.toHaveBeenCalled()
  })

  it('keeps Shed funding inside the displayed ceiling even when a permit adds cost', async () => {
    getTokenPermitInfo.mockResolvedValue({ type: 'eip-2612', name: 'DAI' })
    getQuoteOnly.mockResolvedValueOnce(quoteResult).mockResolvedValueOnce({
      ...quoteResult,
      orderToSign: {
        ...quoteResult.orderToSign,
        sellAmount: '12000000000000000',
      },
    })
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      hardMaximumSell: true,
    })
    expect(result.isErr()).toBe(true)
    expect(postSwapOrderFromQuote).not.toHaveBeenCalled()
  })

  it('quotes an exact USDC buy from the selected token', async () => {
    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
    })

    expect(result.isOk()).toBe(true)
    expect(getQuoteOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'buy',
        sellToken: DAI.address,
        sellTokenDecimals: 18,
        buyToken: USDC,
        amount: '20000000',
        receiver: HCA,
      }),
    )
    expect(viemAdapterConstructor).toHaveBeenCalledOnce()
    expect(viemAdapterConstructor).toHaveBeenCalledWith({
      provider: publicClient,
    })
  })

  it('does not replace an adapter that is already configured while polling', async () => {
    getGlobalAdapter.mockReturnValue({})

    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
    })

    expect(result.isOk()).toBe(true)
    expect(viemAdapterConstructor).not.toHaveBeenCalled()
  })

  it('prices the CoW SDK permit hook at checkout', async () => {
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })

    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
    })

    expect(result.isOk()).toBe(true)
    expect(getQuoteOnly).toHaveBeenCalledTimes(2)
    expect(getQuoteOnly).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        appData: {
          metadata: {
            hooks: expect.objectContaining({
              pre: expect.arrayContaining([
                expect.objectContaining({ gasLimit: '160000' }),
              ]),
            }),
          },
        },
      }),
    )
  })

  it('prices the permit when an exact prior allowance does not cover checkout drift', async () => {
    getCowProtocolAllowance.mockResolvedValue(
      BigInt(quoteResult.orderToSign.sellAmount),
    )
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })

    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
    })

    expect(result.isOk()).toBe(true)
    expect(getQuoteOnly).toHaveBeenCalledTimes(2)
    expect(generatePermitHook).toHaveBeenCalledOnce()
  })

  it('omits the permit only when an existing allowance covers checkout drift', async () => {
    getCowProtocolAllowance.mockResolvedValue(
      withBps(BigInt(quoteResult.orderToSign.sellAmount), 300n),
    )
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })

    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
    })

    expect(result.isOk()).toBe(true)
    expect(getQuoteOnly).toHaveBeenCalledOnce()
    expect(generatePermitHook).not.toHaveBeenCalled()
  })

  it('fails checkout instead of silently omitting a supported permit hook', async () => {
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })
    generatePermitHook.mockResolvedValue(undefined)

    const result = await quoteCowSwap({
      publicClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
    })

    expect(result.isErr()).toBe(true)
    expect(getQuoteOnly).toHaveBeenCalledOnce()
  })

  it('approves only the refreshed maximum and posts a gasless order', async () => {
    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
    })

    expect(result._unsafeUnwrap().order).toEqual({
      orderId: 'erc20-order-id',
      validTo: 1_800_000_000,
      kind: 'erc20',
      amountOut: 20_000_000n,
    })
    expect(approveCowProtocol).toHaveBeenCalledWith({
      tokenAddress: DAI.address,
      amount: 10_500_000_000_000_000n,
    })
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(publicClient, {
      hash: APPROVAL_HASH,
    })
    expect(viemAdapterConstructor).toHaveBeenCalledOnce()
    expect(viemAdapterConstructor).toHaveBeenCalledWith({
      provider: publicClient,
      walletClient,
    })
    expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
  })

  it('does not ask for another approval when allowance is sufficient', async () => {
    getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
    })

    expect(result.isOk()).toBe(true)
    expect(approveCowProtocol).not.toHaveBeenCalled()
    expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
  })

  it('uses a bounded CoW permit hook without revoking an existing COW allowance', async () => {
    getCowProtocolAllowance.mockResolvedValue(1n)
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
      maximumSell: 11_000_000_000_000_000n,
      hooks,
    })

    expect(result.isOk()).toBe(true)
    expect(generatePermitHook).toHaveBeenCalledWith(
      expect.objectContaining({
        account: WALLET,
        amount: 16_500_000_000_000_000n,
        nonce: 0,
      }),
    )
    expect(approveCowProtocol).not.toHaveBeenCalled()
    expect(getQuote).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        appData: {
          metadata: {
            hooks: expect.objectContaining({
              pre: expect.arrayContaining([
                expect.objectContaining({
                  target: DAI.address,
                  callData: expect.stringMatching(/^0xd505accf/),
                  gasLimit: '160000',
                }),
              ]),
            }),
          },
        },
      }),
    )
    expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
  })

  it('does not mistake signed permit execution cost for market price movement', async () => {
    const signedPermitQuote = {
      ...quoteResult,
      orderToSign: {
        ...quoteResult.orderToSign,
        sellAmount: '14000000000000000',
      },
    }
    getCowProtocolAllowance.mockResolvedValue(0n)
    getTokenPermitInfo.mockResolvedValue({
      type: 'eip-2612',
      name: 'CoW Protocol Token',
      version: '1',
    })
    getQuoteOnly
      .mockResolvedValueOnce(quoteResult)
      .mockResolvedValueOnce(signedPermitQuote)
    getQuote.mockResolvedValue({
      quoteResults: signedPermitQuote,
      postSwapOrderFromQuote,
    })

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: { ...DAI, symbol: 'COW' },
      maximumSell: 11_000_000_000_000_000n,
      hooks,
    })

    expect(result.isOk()).toBe(true)
    expect(generatePermitHook).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 16_500_000_000_000_000n }),
    )
    expect(postSwapOrderFromQuote).toHaveBeenCalledOnce()
  })

  it('binds the same hooks into the quote and signed order app-data', async () => {
    getCowProtocolAllowance.mockResolvedValue(10_500_000_000_000_000n)

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
      hooks,
    })

    expect(result.isOk()).toBe(true)
    const advancedSettings = {
      appData: {
        metadata: {
          hooks: {
            version: '0.2.0',
            pre: hooks.pre.map((hook) => ({
              ...hook,
              gasLimit: hook.gasLimit.toString(),
            })),
            post: hooks.post.map((hook) => ({
              ...hook,
              gasLimit: hook.gasLimit.toString(),
            })),
          },
        },
      },
    }
    expect(getQuoteOnly).toHaveBeenCalledWith(
      expect.any(Object),
      advancedSettings,
    )
    expect(getQuote).toHaveBeenCalledWith(expect.any(Object), advancedSettings)
    expect(postSwapOrderFromQuote).toHaveBeenCalledWith()
  })

  it('does not revoke a standard token allowance before increasing it', async () => {
    getCowProtocolAllowance.mockResolvedValue(1n)

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: DAI,
      maximumSell: 11_000_000_000_000_000n,
    })

    expect(result.isOk()).toBe(true)
    expect(approveCowProtocol).toHaveBeenCalledOnce()
    expect(approveCowProtocol).toHaveBeenCalledWith({
      tokenAddress: DAI.address,
      amount: 10_500_000_000_000_000n,
    })
  })

  it('resets only USDT-style non-zero allowance before changing it', async () => {
    getCowProtocolAllowance.mockResolvedValue(1n)
    approveCowProtocol
      .mockResolvedValueOnce(APPROVAL_HASH)
      .mockResolvedValueOnce(HASH)

    const result = await submitCowSwap({
      publicClient,
      walletClient,
      chainId: sepolia.id,
      owner: WALLET,
      receiver: HCA,
      amountOut: 20_000_000n,
      sellToken: USDT,
      maximumSell: 11_000_000_000_000_000n,
    })

    expect(result.isOk()).toBe(true)
    expect(approveCowProtocol).toHaveBeenNthCalledWith(1, {
      tokenAddress: DAI.address,
      amount: 0n,
    })
    expect(approveCowProtocol).toHaveBeenNthCalledWith(2, {
      tokenAddress: DAI.address,
      amount: 10_500_000_000_000_000n,
    })
  })
})

it('rounds consent bounds up', () => {
  expect(withBps(9_709n, 300n)).toBe(10_001n)
})
