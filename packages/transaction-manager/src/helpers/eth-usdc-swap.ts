/**
 * Exact-output USDC funding through CoW Protocol.
 *
 * Native ETH uses EthFlow. ERC-20s use a gasless CoW order after ensuring the
 * Vault Relayer has the exact allowance required by the refreshed quote. The
 * receiver can be either the user's EOA or their ENS smart account.
 */

import {
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  calculateUniqueOrderId,
  type EnrichedOrder,
  ETH_ADDRESS,
  getGlobalAdapter,
  getTradeParametersAfterQuote,
  OrderBookApi,
  OrderKind,
  postSellNativeCurrencyOrder,
  type QuoteResults,
  SupportedChainId,
  type SwapAdvancedSettings,
  swapParamsToLimitOrderParams,
  TradingSdk,
} from '@cowprotocol/cow-sdk'
import {
  generatePermitHook,
  getPermitUtilsInstance,
  getTokenPermitInfo,
  isSupportedPermitInfo,
  type PermitInfo,
} from '@cowprotocol/permit-utils'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { getDestinationContracts } from '@ens-apps/smart-account'
import { ResultFn, TaggedError } from '@ens-apps/utils/neverthrow'
import { err, fromPromise, ok, type Result } from 'neverthrow'
import {
  type Address,
  getAddress,
  type Hash,
  type Hex,
  type PublicClient,
  parseAbi,
  type WalletClient,
} from 'viem'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import { type Config, createConfig } from 'wagmi'

import type { WalletProgress } from '../machines/registration/registration.wallet-progress'

const APP_CODE = 'ens-app'
const USDC_DECIMALS = 6
const ORDER_VALID_FOR_SECONDS = 20 * 60
const SLIPPAGE_BPS = 200
const BPS = 10_000n
/** ETH has 18 decimals, USDC 6 and the Chainlink feed 8. */
const USDC_TO_WEI_AT_FEED_SCALE = 10n ** 20n

const ETH_USD_FEEDS: Readonly<
  Record<number, { readonly address: Address; readonly maxAgeSeconds: bigint }>
> = {
  1: {
    address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    maxAgeSeconds: 7_200n,
  },
  11155111: {
    address: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
    maxAgeSeconds: 86_400n,
  },
}

const ethUsdFeedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

const ZERO_FIRST_APPROVAL_SYMBOLS = new Set(['USDT'])
// CoW's account-agnostic checkout permit can cost materially less than the
// user's real hook (cold nonce/allowance writes). Keep that execution reserve
// bounded; the exact order amount is still separately authorized by the CoW
// order signature.
const PERMIT_HOOK_EXECUTION_RESERVE_BPS = 5_000n

export const ETH_SWAP_DISPLAYED_DRIFT_BPS = 300n

const divCeil = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator

export const withBps = (value: bigint, bps: bigint): bigint =>
  divCeil(value * (BPS + bps), BPS)

export class EthSwapUnavailableError extends TaggedError(
  'EthSwapUnavailableError',
)<{ message: string; cause?: unknown }> {}

/** Submission may be durable or posted; recover before starting another payment. */
export class CowSwapSubmissionError extends EthSwapUnavailableError {}

export class EthSwapRejectedError extends TaggedError('EthSwapRejectedError')<{
  message: string
}> {}

export type EthUsdRound = Readonly<{
  roundId: bigint
  answer: bigint
  updatedAt: bigint
  answeredInRound: bigint
}>

export function validateEthUsdRound(
  round: EthUsdRound,
  nowSeconds: bigint,
  maxAgeSeconds: bigint,
): Result<bigint, EthSwapUnavailableError> {
  const isUsable =
    round.answer > 0n &&
    round.answeredInRound >= round.roundId &&
    round.updatedAt > 0n &&
    round.updatedAt <= nowSeconds &&
    nowSeconds - round.updatedAt <= maxAgeSeconds
  return isUsable
    ? ok(round.answer)
    : err(
        new EthSwapUnavailableError({
          message: 'The ETH price feed is unavailable. Try again later.',
        }),
      )
}

/** Chainlink ETH/USD remains useful for displaying native-ETH balances and gas. */
export const readEthUsdPrice = ResultFn(async function* (params: {
  readonly publicClient: PublicClient
  readonly chainId: number
  readonly nowSeconds: bigint
}) {
  const feed = ETH_USD_FEEDS[params.chainId]
  if (!feed) {
    return err(
      new EthSwapUnavailableError({
        message: 'Paying with ETH is not available on this network.',
      }),
    )
  }
  const [roundId, answer, , updatedAt, answeredInRound] = yield* fromPromise(
    readContract(params.publicClient, {
      address: feed.address,
      abi: ethUsdFeedAbi,
      functionName: 'latestRoundData',
    }),
    (cause) =>
      new EthSwapUnavailableError({
        message: 'The ETH price feed is unavailable. Try again later.',
        cause,
      }),
  )
  return validateEthUsdRound(
    { roundId, answer, updatedAt, answeredInRound },
    params.nowSeconds,
    feed.maxAgeSeconds,
  )
})

export const ethToUsdcRaw = (wei: bigint, ethUsd: bigint): bigint =>
  (wei * ethUsd) / USDC_TO_WEI_AT_FEED_SCALE

export type CowSellToken = Readonly<{
  address: Address
  symbol: string
  decimals: number
  isNative: boolean
}>

export const NATIVE_ETH: CowSellToken = {
  address: ETH_ADDRESS as Address,
  symbol: 'ETH',
  decimals: 18,
  isNative: true,
}

export type CowSwapQuote = Readonly<{
  /** Exact USDC amount the receiver must get. */
  amountOut: bigint
  /** Maximum sell-token amount, including quote costs and slippage. */
  maximumSell: bigint
  /** Native-ETH compatibility alias; equal to `maximumSell`. */
  maximumEth: bigint
  /** Quote validity used by the order. */
  validTo: number
}>

/** Backwards-compatible alias while registration persistence is migrated. */
export type EthSwapQuote = CowSwapQuote

export type CowSwapOrder = Readonly<{
  orderId: string
  validTo: number
  kind: 'native' | 'erc20'
  /** Exact USDC amount this order buys. Used to resume without paying twice. */
  amountOut?: bigint
  /** EthFlow creation transaction. ERC-20 orders are posted off-chain. */
  hash?: Hash
}>

export type CowHook = Readonly<{
  target: Address
  callData: Hex
  gasLimit: number
}>

export type CowSwapHooks = Readonly<{
  pre?: readonly CowHook[]
  post?: readonly CowHook[]
}>

const permitConfigCache = new WeakMap<object, Config>()
const permitInfoListCache = new Map<
  number,
  Promise<Readonly<Record<string, PermitInfo>>>
>()

/** CoW Swap's reviewed permit metadata takes precedence over runtime probing. */
const getListedPermitInfo = async (
  chainId: SupportedChainId,
  token: Address,
): Promise<PermitInfo | undefined> => {
  let request = permitInfoListCache.get(chainId)
  if (!request) {
    request = fetch(
      `https://files.cow.fi/token-lists/PermitInfo.${chainId}.json`,
    )
      .then((response) =>
        response.ok
          ? (response.json() as Promise<Readonly<Record<string, PermitInfo>>>)
          : {},
      )
      .catch(() => ({}))
    permitInfoListCache.set(chainId, request)
  }
  const list = await request
  return list[token.toLowerCase()]
}

/**
 * CoW Swap's permit utility expects a wagmi config for its gas simulation.
 * Reuse the exact transport already selected by the host app. Wrapping
 * `publicClient.request` in a custom transport creates a nested request path
 * that can stall in Viem's batch scheduler; CoW Swap passes its real Wagmi
 * transport directly too.
 */
const permitConfigFor = (publicClient: PublicClient): Config => {
  const cached = permitConfigCache.get(publicClient)
  if (cached) return cached
  const { chain } = publicClient
  if (!chain) throw new Error('A chain is required to prepare a CoW permit.')
  const config = createConfig({
    chains: [chain],
    multiInjectedProviderDiscovery: false,
    transports: {
      [chain.id]: () => ({
        config: publicClient.transport,
        request: publicClient.transport.request,
        value: publicClient.transport,
      }),
    },
  })
  permitConfigCache.set(publicClient, config)
  return config
}

/**
 * Build the same EIP-2612/Dai-like permit pre-hook used by CoW Swap. Without a
 * wallet it produces their account-agnostic quote stand-in; with a wallet it
 * requests the real off-chain permit signature.
 */
const buildCowSellTokenPermitHook = async (params: {
  publicClient: PublicClient
  walletClient?: WalletClient
  chainId: SupportedChainId
  owner: Address
  sellToken: CowSellToken
  amount: bigint
  readonly onWalletProgress?: (progress: WalletProgress) => void
  readonly signal?: AbortSignal
}): Promise<CowHook | undefined> => {
  params.signal?.throwIfAborted()
  if (params.sellToken.isNative) return undefined
  const spender = getAddress(COW_PROTOCOL_VAULT_RELAYER_ADDRESS[params.chainId])
  const config = permitConfigFor(params.publicClient)
  const permitInfo =
    (await getListedPermitInfo(params.chainId, params.sellToken.address)) ??
    (await getTokenPermitInfo({
      chainId: params.chainId,
      config: config as never,
      publicClient: params.publicClient as never,
      spender,
      tokenAddress: params.sellToken.address,
      amount: params.amount,
    }).catch((error: unknown) => ({ error: String(error) })))
  params.signal?.throwIfAborted()
  if ('error' in permitInfo || !isSupportedPermitInfo(permitInfo)) {
    return undefined
  }
  const eip2612Utils = await getPermitUtilsInstance({
    chainId: params.chainId,
    publicClient: params.publicClient as never,
    ...(params.walletClient
      ? {
          account: params.owner,
          walletClient: params.walletClient as never,
        }
      : {}),
  })
  const nonce = params.walletClient
    ? await eip2612Utils.getTokenNonce(params.sellToken.address, params.owner)
    : undefined
  params.signal?.throwIfAborted()
  if (params.walletClient) {
    params.onWalletProgress?.({
      action: 'tokenPermit',
      phase: 'awaitingSignature',
    })
  }
  const hook = await generatePermitHook({
    account: params.walletClient ? params.owner : undefined,
    amount: params.amount,
    chainId: params.chainId,
    config: config as never,
    eip2612Utils,
    inputToken: {
      address: params.sellToken.address,
      name: permitInfo.name ?? params.sellToken.symbol,
    },
    nonce,
    permitInfo,
    spender,
  })
  if (!hook) {
    throw new Error(
      `CoW could not prepare a gasless ${params.sellToken.symbol} permit.`,
    )
  }
  if (params.walletClient) {
    params.onWalletProgress?.({ action: 'tokenPermit', phase: 'completed' })
  }
  return hook
    ? {
        target: getAddress(hook.target),
        callData: hook.callData as Hex,
        gasLimit: Number(hook.gasLimit),
      }
    : undefined
}

/** CoW Swap appends its token permit to any other pre-interactions. */
const withSellTokenPermit = (
  hooks: CowSwapHooks | undefined,
  permit: CowHook | undefined,
): CowSwapHooks | undefined =>
  permit
    ? {
        pre: [...(hooks?.pre ?? []), permit],
        ...(hooks?.post ? { post: hooks.post } : {}),
      }
    : hooks

const advancedSettingsFor = (
  hooks?: CowSwapHooks,
): SwapAdvancedSettings | undefined =>
  hooks
    ? {
        appData: {
          metadata: {
            hooks: {
              version: '0.2.0',
              ...(hooks.pre
                ? {
                    pre: hooks.pre.map((hook) => ({
                      ...hook,
                      gasLimit: hook.gasLimit.toString(),
                    })),
                  }
                : {}),
              ...(hooks.post
                ? {
                    post: hooks.post.map((hook) => ({
                      ...hook,
                      gasLimit: hook.gasLimit.toString(),
                    })),
                  }
                : {}),
            },
          },
        },
      }
    : undefined

/** Backwards-compatible alias while registration persistence is migrated. */
export type CowEthOrder = CowSwapOrder

const asSupportedChain = (
  chainId: number,
): Result<SupportedChainId, EthSwapUnavailableError> =>
  chainId === SupportedChainId.MAINNET || chainId === SupportedChainId.SEPOLIA
    ? ok(chainId)
    : err(
        new EthSwapUnavailableError({
          message: 'Paying with this token is not available on this network.',
        }),
      )

const tradeParameters = (params: {
  chainId: SupportedChainId
  owner: Address
  receiver: Address
  amountOut: bigint
  sellToken: CowSellToken
  fixedValidTo?: number
}) => ({
  chainId: params.chainId,
  appCode: APP_CODE,
  owner: params.owner,
  kind: OrderKind.BUY,
  sellToken: params.sellToken.isNative ? ETH_ADDRESS : params.sellToken.address,
  sellTokenDecimals: params.sellToken.decimals,
  buyToken: getDestinationContracts(params.chainId).usdc,
  buyTokenDecimals: USDC_DECIMALS,
  amount: params.amountOut.toString(),
  receiver: params.receiver,
  ...(params.fixedValidTo === undefined
    ? { validFor: ORDER_VALID_FOR_SECONDS }
    : { validTo: params.fixedValidTo }),
  slippageBps: SLIPPAGE_BPS,
})

const createCowClients = (params: {
  publicClient: PublicClient
  chainId: SupportedChainId
  walletClient?: WalletClient
}) => {
  const orderBookApi = new OrderBookApi({ chainId: params.chainId })

  // The CoW SDK adapter is process-global. Match CoW Swap's lifecycle:
  // install one read-only adapter so fresh-page quotes can build app-data,
  // upgrade it when a wallet is connected, and never let polling downgrade a
  // connected adapter while an approval is confirming.
  const adapter = (() => {
    if (params.walletClient) {
      return new ViemAdapter({
        provider: params.publicClient,
        walletClient: params.walletClient,
      })
    }
    try {
      getGlobalAdapter()
      return undefined
    } catch {
      return new ViemAdapter({ provider: params.publicClient })
    }
  })()
  const sdk = new TradingSdk(
    { chainId: params.chainId, appCode: APP_CODE },
    { orderBookApi },
    adapter,
  )
  return { orderBookApi, sdk }
}

const toQuote = (amountOut: bigint, result: QuoteResults): CowSwapQuote => ({
  amountOut,
  maximumSell: BigInt(result.orderToSign.sellAmount),
  maximumEth: BigInt(result.orderToSign.sellAmount),
  validTo: result.orderToSign.validTo,
})

/** Quote buying the exact USDC funding requirement with any CoW sell token. */
export const quoteCowSwap = ResultFn(async function* (params: {
  readonly publicClient: PublicClient
  readonly chainId: number
  readonly owner: Address
  readonly receiver: Address
  readonly amountOut: bigint
  readonly sellToken: CowSellToken
  readonly hooks?: CowSwapHooks
  readonly fixedValidTo?: number
}) {
  const chainId = yield* asSupportedChain(params.chainId)
  const { sdk } = createCowClients({
    publicClient: params.publicClient,
    chainId,
  })
  const trade = tradeParameters({
    chainId,
    owner: params.owner,
    receiver: params.receiver,
    amountOut: params.amountOut,
    sellToken: params.sellToken,
    fixedValidTo: params.fixedValidTo,
  })
  const advancedSettings = advancedSettingsFor(params.hooks)
  const result = yield* fromPromise(
    advancedSettings
      ? sdk.getQuoteOnly(trade, advancedSettings)
      : sdk.getQuoteOnly(trade),
    (cause) =>
      new EthSwapUnavailableError({
        message: `CoW Protocol could not quote payment with ${params.sellToken.symbol}.`,
        cause,
      }),
  )
  const initialQuote = toQuote(params.amountOut, result)
  if (params.sellToken.isNative) return ok(initialQuote)

  // Match CoW Swap: when the sell token supports EIP-2612/Dai-like permit and
  // allowance is short, include an account-agnostic permit hook in the quote.
  // Its target, calldata shape and gas limit price the same solver work as the
  // real permit the wallet signs at submission time.
  const allowance = await sdk
    .getCowProtocolAllowance({
      tokenAddress: params.sellToken.address,
      owner: params.owner,
    })
    .catch(() => 0n)
  // An exact prior approval can cover the checkout quote but become too small
  // after even minor price movement. If that happens, submission suddenly
  // needs a permit hook whose fixed solver cost was absent from checkout and
  // can exceed the user's percentage ceiling on small purchases. Only omit
  // the permit when the existing allowance covers the same drift window that
  // checkout promises.
  if (
    allowance >= withBps(initialQuote.maximumSell, ETH_SWAP_DISPLAYED_DRIFT_BPS)
  ) {
    return ok(initialQuote)
  }
  const permit = yield* fromPromise(
    buildCowSellTokenPermitHook({
      publicClient: params.publicClient,
      chainId,
      owner: params.owner,
      sellToken: params.sellToken,
      amount: initialQuote.maximumSell,
    }),
    (cause) =>
      new EthSwapUnavailableError({
        message: `CoW Protocol could not quote the gasless ${params.sellToken.symbol} approval.`,
        cause,
      }),
  )
  if (!permit) return ok(initialQuote)
  const permitSettings = advancedSettingsFor(
    withSellTokenPermit(params.hooks, permit),
  )
  const permitResult = yield* fromPromise(
    permitSettings
      ? sdk.getQuoteOnly(trade, permitSettings)
      : sdk.getQuoteOnly(trade),
    (cause) =>
      new EthSwapUnavailableError({
        message: `CoW Protocol could not quote the gasless ${params.sellToken.symbol} approval.`,
        cause,
      }),
  )
  return ok(toQuote(params.amountOut, permitResult))
})

/** Backwards-compatible native-ETH quote helper. */
export const quoteEthSwap = (
  params: Omit<Parameters<typeof quoteCowSwap>[0], 'sellToken'>,
) => quoteCowSwap({ ...params, sellToken: NATIVE_ETH })

const waitForSuccessfulReceipt = async (
  publicClient: PublicClient,
  hash: Hash,
  message: string,
) => {
  const receipt = await waitForTransactionReceipt(publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(message)
}

/**
 * Ensure a non-permittable ERC-20 can fund the order. Approval is exact, not
 * unlimited. Only zero-first tokens such as USDT are reset before changing a
 * non-zero allowance; standard ERC-20s must never receive a spurious revoke.
 */
const ensureCowAllowance = async (params: {
  sdk: TradingSdk
  publicClient: PublicClient
  owner: Address
  sellToken: CowSellToken
  amount: bigint
  readonly onWalletProgress?: (progress: WalletProgress) => void
  readonly signal?: AbortSignal
}) => {
  const allowance = await params.sdk.getCowProtocolAllowance({
    tokenAddress: params.sellToken.address,
    owner: params.owner,
  })
  params.signal?.throwIfAborted()
  if (allowance >= params.amount) return
  if (
    allowance > 0n &&
    ZERO_FIRST_APPROVAL_SYMBOLS.has(params.sellToken.symbol.toUpperCase())
  ) {
    params.onWalletProgress?.({
      action: 'resetAllowance',
      phase: 'awaitingSignature',
    })
    const resetHash = await params.sdk.approveCowProtocol({
      tokenAddress: params.sellToken.address,
      amount: 0n,
    })
    params.onWalletProgress?.({
      action: 'resetAllowance',
      phase: 'awaitingConfirmation',
    })
    await waitForSuccessfulReceipt(
      params.publicClient,
      resetHash as Hash,
      `${params.sellToken.symbol} allowance reset failed on-chain.`,
    )
    params.onWalletProgress?.({ action: 'resetAllowance', phase: 'completed' })
  }
  params.signal?.throwIfAborted()
  params.onWalletProgress?.({
    action: 'tokenApproval',
    phase: 'awaitingSignature',
  })
  const approvalHash = await params.sdk.approveCowProtocol({
    tokenAddress: params.sellToken.address,
    amount: params.amount,
  })
  params.onWalletProgress?.({
    action: 'tokenApproval',
    phase: 'awaitingConfirmation',
  })
  await waitForSuccessfulReceipt(
    params.publicClient,
    approvalHash as Hash,
    `${params.sellToken.symbol} approval failed on-chain.`,
  )
  params.onWalletProgress?.({ action: 'tokenApproval', phase: 'completed' })
}

/** Add CoW Swap's gasless sell-token permit when the current allowance is short. */
const prepareSellTokenAuthorization = async (params: {
  sdk: TradingSdk
  publicClient: PublicClient
  walletClient: WalletClient
  chainId: SupportedChainId
  owner: Address
  sellToken: CowSellToken
  maximumSell: bigint
  amountOut: bigint
  trade: ReturnType<typeof tradeParameters>
  hooks?: CowSwapHooks
  refreshed: QuoteResults
  readonly onWalletProgress?: (progress: WalletProgress) => void
  readonly signal?: AbortSignal
}) => {
  const initialQuote = toQuote(params.amountOut, params.refreshed)
  if (params.sellToken.isNative) {
    return {
      activeHooks: params.hooks,
      refreshed: params.refreshed,
      refreshedQuote: initialQuote,
      usesSellTokenPermit: false,
    }
  }
  const allowance = await params.sdk.getCowProtocolAllowance({
    tokenAddress: params.sellToken.address,
    owner: params.owner,
  })
  if (allowance >= initialQuote.maximumSell) {
    return {
      activeHooks: params.hooks,
      refreshed: params.refreshed,
      refreshedQuote: initialQuote,
      usesSellTokenPermit: false,
    }
  }
  params.signal?.throwIfAborted()
  const permit = await buildCowSellTokenPermitHook({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    chainId: params.chainId,
    owner: params.owner,
    sellToken: params.sellToken,
    // Keep the signed permit bounded across the hook and final quotes.
    amount: params.maximumSell,
    signal: params.signal,
    onWalletProgress: params.onWalletProgress,
  })
  params.signal?.throwIfAborted()
  if (!permit) {
    return {
      activeHooks: params.hooks,
      refreshed: params.refreshed,
      refreshedQuote: initialQuote,
      usesSellTokenPermit: false,
    }
  }
  const activeHooks = withSellTokenPermit(params.hooks, permit)
  const advancedSettings = advancedSettingsFor(activeHooks)
  const refreshed = advancedSettings
    ? await params.sdk.getQuoteOnly(params.trade, advancedSettings)
    : await params.sdk.getQuoteOnly(params.trade)
  return {
    activeHooks,
    refreshed,
    refreshedQuote: toQuote(params.amountOut, refreshed),
    usesSellTokenPermit: true,
  }
}

const sellTokenPermitMaximum = (params: {
  readonly priceLimit?: 'checkoutMaximum' | 'latestQuote'
  readonly initialMaximumSell: bigint
  readonly maximumSell: bigint
  readonly hardMaximumSell?: boolean
}): bigint => {
  if (params.priceLimit === 'latestQuote') {
    return withBps(params.initialMaximumSell, PERMIT_HOOK_EXECUTION_RESERVE_BPS)
  }
  return params.hardMaximumSell
    ? params.maximumSell
    : withBps(params.maximumSell, PERMIT_HOOK_EXECUTION_RESERVE_BPS)
}

const cowAuthorizationLimits = (params: {
  readonly priceLimit?: 'checkoutMaximum' | 'latestQuote'
  readonly maximumSell: bigint
  readonly permitMaximumSell: bigint
  readonly usesSellTokenPermit: boolean
}): {
  readonly checkoutMaximumSell: bigint | undefined
  readonly signedPermitMaximumSell: bigint | undefined
} => {
  if (params.priceLimit === 'latestQuote') {
    return {
      checkoutMaximumSell: undefined,
      signedPermitMaximumSell: params.usesSellTokenPermit
        ? params.permitMaximumSell
        : undefined,
    }
  }
  return {
    checkoutMaximumSell: params.usesSellTokenPermit
      ? params.permitMaximumSell
      : params.maximumSell,
    signedPermitMaximumSell: undefined,
  }
}

const needsFinalCowAllowance = (
  priceLimit: 'checkoutMaximum' | 'latestQuote' | undefined,
  usesSellTokenPermit: boolean,
  refreshedMaximumSell: bigint,
  finalMaximumSell: bigint,
): boolean =>
  priceLimit === 'latestQuote' &&
  !usesSellTokenPermit &&
  finalMaximumSell > refreshedMaximumSell

const exceedsCowPriceLimit = (
  maximumSell: bigint,
  limit: bigint | undefined,
): boolean => limit !== undefined && maximumSell > limit

const validateCowPermitAmount = (
  maximumSell: bigint,
  permitMaximumSell: bigint | undefined,
): Result<void, EthSwapRejectedError> =>
  exceedsCowPriceLimit(maximumSell, permitMaximumSell)
    ? err(
        new EthSwapRejectedError({
          message:
            'The quote exceeds the signed sell-token permit. Please quote again.',
        }),
      )
    : ok(undefined)

/** Reject an expiry that can settle after the authorized setup hook expires. */
const validateCowExpiry = (
  validTo: number,
  fixedValidTo: number | undefined,
): Result<void, EthSwapRejectedError> =>
  fixedValidTo !== undefined && validTo > fixedValidTo
    ? err(
        new EthSwapRejectedError({
          message:
            'The CoW order expires after its signed registration hook. Quote again.',
        }),
      )
    : ok(undefined)

/** Stop before another wallet request when the caller cancelled the run. */
const validateCowCancellation = (
  isAborted: boolean,
): Result<void, EthSwapRejectedError> =>
  isAborted
    ? err(
        new EthSwapRejectedError({
          message: 'The CoW payment was cancelled before submission.',
        }),
      )
    : ok(undefined)

/** Await durable storage before the SDK can sign and post an order. */
const checkpointCowSubmission = ResultFn(async function* (params: {
  readonly onBeforeOrderSubmission?: () => Promise<void>
  readonly signal?: AbortSignal
}) {
  yield* validateCowCancellation(params.signal?.aborted === true)
  if (params.onBeforeOrderSubmission) {
    yield* fromPromise(
      Promise.resolve().then(() => params.onBeforeOrderSubmission?.()),
      (cause) =>
        new CowSwapSubmissionError({
          message: 'The CoW submission checkpoint could not be saved.',
          cause,
        }),
    )
  }
  return validateCowCancellation(params.signal?.aborted === true).mapErr(
    (cause) =>
      new CowSwapSubmissionError({
        message: cause.message,
        cause,
      }),
  )
})

/** Refresh, price-check, authorize, sign, and post an exact-output CoW order. */
export const submitCowSwap = ResultFn(async function* (params: {
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly chainId: number
  readonly owner: Address
  readonly receiver: Address
  readonly amountOut: bigint
  readonly sellToken: CowSellToken
  /** Checkout ceiling, unless priceLimit selects the latest quote. */
  readonly maximumSell: bigint
  /** Keep checkout consent by default; latestQuote uses fresh wallet authorization. */
  readonly priceLimit?: 'checkoutMaximum' | 'latestQuote'
  readonly hooks?: CowSwapHooks
  /** Shed hooks bind the first order to this exact expiry. */
  readonly fixedValidTo?: number
  /** Under checkoutMaximum, do not expand consent for a sell-token permit hook. */
  readonly hardMaximumSell?: boolean
  /** Persist the submission checkpoint before the SDK signs and posts. */
  readonly onBeforeOrderSubmission?: () => Promise<void>
  readonly onOrderSent?: (order: CowSwapOrder) => Promise<void>
  readonly onWalletProgress?: (progress: WalletProgress) => void
  readonly signal?: AbortSignal
}) {
  yield* validateCowCancellation(params.signal?.aborted === true)
  const chainId = yield* asSupportedChain(params.chainId)
  const { orderBookApi, sdk } = createCowClients({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    chainId,
  })
  const trade = tradeParameters({
    chainId,
    owner: params.owner,
    receiver: params.receiver,
    amountOut: params.amountOut,
    sellToken: params.sellToken,
    fixedValidTo: params.fixedValidTo,
  })
  const initialSettings = advancedSettingsFor(params.hooks)
  const initialRefresh = yield* fromPromise(
    initialSettings
      ? sdk.getQuoteOnly(trade, initialSettings)
      : sdk.getQuoteOnly(trade),
    (cause) =>
      new EthSwapUnavailableError({
        message: `CoW Protocol could not refresh payment with ${params.sellToken.symbol}.`,
        cause,
      }),
  )
  const initialQuote = toQuote(params.amountOut, initialRefresh)
  yield* validateCowExpiry(initialQuote.validTo, params.fixedValidTo)
  // Check the market quote before requesting a permit. The permit hook has a
  // fixed execution cost that is not price movement and is bounded by the
  // amount the user signs separately below.
  const checkoutMaximumSell =
    params.priceLimit === 'latestQuote' ? undefined : params.maximumSell
  if (exceedsCowPriceLimit(initialQuote.maximumSell, checkoutMaximumSell)) {
    return err(
      new EthSwapRejectedError({
        message:
          'The price moved beyond the amount approved at checkout. Please quote again.',
      }),
    )
  }
  yield* validateCowCancellation(params.signal?.aborted === true)
  const permitMaximumSell = sellTokenPermitMaximum({
    priceLimit: params.priceLimit,
    initialMaximumSell: initialQuote.maximumSell,
    maximumSell: params.maximumSell,
    hardMaximumSell: params.hardMaximumSell,
  })
  const authorization = yield* fromPromise(
    prepareSellTokenAuthorization({
      sdk,
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      chainId,
      owner: params.owner,
      sellToken: params.sellToken,
      maximumSell: permitMaximumSell,
      amountOut: params.amountOut,
      trade,
      hooks: params.hooks,
      refreshed: initialRefresh,
      signal: params.signal,
      onWalletProgress: params.onWalletProgress,
    }),
    (cause) =>
      new EthSwapUnavailableError({
        message: `The ${params.sellToken.symbol} approval could not be prepared.`,
        cause,
      }),
  )
  yield* validateCowCancellation(params.signal?.aborted === true)
  const { activeHooks, refreshed, refreshedQuote, usesSellTokenPermit } =
    authorization
  const advancedSettings = advancedSettingsFor(activeHooks)
  yield* validateCowExpiry(refreshedQuote.validTo, params.fixedValidTo)
  const {
    checkoutMaximumSell: authorizationMaximumSell,
    signedPermitMaximumSell,
  } = cowAuthorizationLimits({
    priceLimit: params.priceLimit,
    maximumSell: params.maximumSell,
    permitMaximumSell,
    usesSellTokenPermit,
  })
  yield* validateCowPermitAmount(
    refreshedQuote.maximumSell,
    signedPermitMaximumSell,
  )

  if (
    exceedsCowPriceLimit(refreshedQuote.maximumSell, authorizationMaximumSell)
  ) {
    return err(
      new EthSwapRejectedError({
        message:
          'The price moved beyond the amount approved at checkout. Please quote again.',
      }),
    )
  }

  if (params.sellToken.isNative) {
    const limitOrder = swapParamsToLimitOrderParams(
      getTradeParametersAfterQuote({
        quoteParameters: refreshed.tradeParameters,
        sellToken: ETH_ADDRESS,
      }),
      refreshed.quoteResponse,
    )
    yield* checkpointCowSubmission(params)
    params.onWalletProgress?.({
      action: 'nativePayment',
      phase: 'awaitingSignature',
    })
    const posted = yield* fromPromise(
      Promise.resolve().then(() =>
        postSellNativeCurrencyOrder(
          orderBookApi,
          refreshed.appDataInfo,
          limitOrder,
          {
            networkCostsAmount: refreshed.quoteResponse.quote.feeAmount,
            protocolFeeBps: refreshed.quoteResponse.protocolFeeBps
              ? Number(refreshed.quoteResponse.protocolFeeBps)
              : undefined,
          },
        ),
      ),
      (cause) =>
        new CowSwapSubmissionError({
          message: 'The CoW Protocol ETH order could not be submitted.',
          cause,
        }),
    )
    if (!posted.txHash) {
      return err(
        new CowSwapSubmissionError({
          message: 'The CoW Protocol ETH order has no transaction hash.',
        }),
      )
    }
    params.onWalletProgress?.({
      action: 'nativePayment',
      phase: 'awaitingConfirmation',
    })
    // EthFlow creates a SELL order even when the SDK retains the BUY quote kind.
    const orderId = yield* fromPromise(
      calculateUniqueOrderId(chainId, {
        ...posted.orderToSign,
        kind: OrderKind.SELL,
      }),
      (cause) =>
        new CowSwapSubmissionError({
          message:
            'The submitted CoW ETH order ID could not be calculated. Do not submit another payment.',
          cause,
        }),
    )
    const order: CowSwapOrder = {
      orderId,
      hash: posted.txHash as Hash,
      validTo: posted.orderToSign.validTo,
      kind: 'native',
      amountOut: params.amountOut,
    }
    if (params.onOrderSent) {
      yield* fromPromise(
        Promise.resolve().then(() => params.onOrderSent?.(order)),
        (cause) =>
          new CowSwapSubmissionError({
            message:
              'The submitted CoW order could not be saved. Do not submit another payment.',
            cause,
          }),
      )
    }
    return ok({ order, quote: refreshedQuote })
  }

  if (!usesSellTokenPermit) {
    yield* fromPromise(
      ensureCowAllowance({
        sdk,
        publicClient: params.publicClient,
        owner: params.owner,
        sellToken: params.sellToken,
        amount: refreshedQuote.maximumSell,
        signal: params.signal,
        onWalletProgress: params.onWalletProgress,
      }),
      (cause) =>
        new EthSwapUnavailableError({
          message: `${params.sellToken.symbol} could not be approved for CoW Protocol.`,
          cause,
        }),
    )
  }

  yield* validateCowCancellation(params.signal?.aborted === true)
  // Approval/permit signing can take long enough for the quote to move, so
  // quote once more and bind the order signature to that exact app-data.
  const postable = yield* fromPromise(
    advancedSettings
      ? sdk.getQuote(trade, advancedSettings)
      : sdk.getQuote(trade),
    (cause) =>
      new EthSwapUnavailableError({
        message: `CoW Protocol could not prepare the ${params.sellToken.symbol} order.`,
        cause,
      }),
  )
  const quote = toQuote(params.amountOut, postable.quoteResults)
  yield* validateCowExpiry(quote.validTo, params.fixedValidTo)
  yield* validateCowPermitAmount(quote.maximumSell, signedPermitMaximumSell)
  if (exceedsCowPriceLimit(quote.maximumSell, authorizationMaximumSell)) {
    return err(
      new EthSwapRejectedError({
        message:
          'The price moved beyond the checkout limit while approval confirmed. Please quote again.',
      }),
    )
  }
  yield* validateCowCancellation(params.signal?.aborted === true)
  if (
    needsFinalCowAllowance(
      params.priceLimit,
      usesSellTokenPermit,
      refreshedQuote.maximumSell,
      quote.maximumSell,
    )
  ) {
    yield* fromPromise(
      ensureCowAllowance({
        sdk,
        publicClient: params.publicClient,
        owner: params.owner,
        sellToken: params.sellToken,
        amount: quote.maximumSell,
        signal: params.signal,
        onWalletProgress: params.onWalletProgress,
      }),
      (cause) =>
        new EthSwapUnavailableError({
          message: `${params.sellToken.symbol} could not be approved for CoW Protocol.`,
          cause,
        }),
    )
  }
  yield* checkpointCowSubmission(params)
  const posted = yield* fromPromise(
    // The quote already contains the exact hook app-data that the user is
    // signing. Re-applying the same override here is unnecessary and can make
    // the posted document diverge from the one that was quoted.
    Promise.resolve().then(() =>
      params.onWalletProgress
        ? postable.postSwapOrderFromQuote(undefined, {
            beforeOrderSign: () =>
              params.onWalletProgress?.({
                action: 'paymentOrder',
                phase: 'awaitingSignature',
              }),
            afterOrderSign: () =>
              params.onWalletProgress?.({
                action: 'paymentOrder',
                phase: 'completed',
              }),
          })
        : postable.postSwapOrderFromQuote(),
    ),
    (cause) =>
      new CowSwapSubmissionError({
        message: `The CoW Protocol ${params.sellToken.symbol} order could not be signed or submitted.`,
        cause,
      }),
  )
  const order: CowSwapOrder = {
    orderId: posted.orderId,
    validTo: postable.quoteResults.orderToSign.validTo,
    kind: 'erc20',
    amountOut: params.amountOut,
  }
  if (params.onOrderSent) {
    yield* fromPromise(
      Promise.resolve().then(() => params.onOrderSent?.(order)),
      (cause) =>
        new CowSwapSubmissionError({
          message:
            'The submitted CoW order could not be saved. Do not submit another payment.',
          cause,
        }),
    )
  }
  return ok({ order, quote })
})

/** Backwards-compatible native-ETH submit helper. */
export const submitEthSwap = (
  params: Omit<
    Parameters<typeof submitCowSwap>[0],
    'sellToken' | 'maximumSell'
  > & { maximumEth: bigint },
) =>
  submitCowSwap({
    ...params,
    maximumSell: params.maximumEth,
    sellToken: NATIVE_ETH,
  })

/** Invalidate an expired EthFlow order and return its escrowed ETH. */
export const refundExpiredEthSwap = ResultFn(async function* (params: {
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly chainId: number
  readonly order: EnrichedOrder
}) {
  const chainId = yield* asSupportedChain(params.chainId)
  const { sdk } = createCowClients({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    chainId,
  })
  const hash = yield* fromPromise(
    sdk.onChainCancelOrder(
      { orderUid: params.order.uid, chainId, signer: params.walletClient },
      params.order,
    ),
    (cause) =>
      new EthSwapUnavailableError({
        message: 'The expired EthFlow order could not be refunded.',
        cause,
      }),
  )
  return ok(hash as Hash)
})
