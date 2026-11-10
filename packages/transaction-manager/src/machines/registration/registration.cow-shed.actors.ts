import {
  OrderBookApi,
  OrderBookApiError,
  OrderStatus,
  SupportedChainId,
} from '@cowprotocol/cow-sdk'
import { getDestinationContracts } from '@ens-apps/smart-account'
import { ResultFn, TaggedError } from '@ens-apps/utils/neverthrow'
import {
  ethRegistrarCommitmentsSnippet,
  ethRegistrarGetRegisterPriceSnippet,
} from '@ensdomains/ensjs-abi/v2/ethRegistrar'
import {
  type Err,
  err,
  fromPromise,
  ok,
  Result,
  type ResultAsync,
} from 'neverthrow'
import {
  type Address,
  erc20Abi,
  type Hash,
  isAddressEqual,
  type PublicClient,
  parseAbi,
  TransactionReceiptNotFoundError,
  type WalletClient,
  zeroHash,
} from 'viem'
import {
  type CowSellToken,
  CowSwapSubmissionError,
  quoteCowSwap,
  readEthUsdPrice,
  submitCowSwap,
} from '../../helpers/eth-usdc-swap'
import { verifyRegistrationActor } from './registration.actors'
import {
  buildCowShedOrderRequest,
  COMPOSABLE_COW,
  type CowConditionalOrderSubmission,
  estimateCowShedExecutionBudget,
  getCowShedAddress,
  getCowShedConditionalOrderHash,
  getCowShedOrderUid,
  getCowShedQuoteValidity,
  prepareCowShedQuoteHooks,
  prepareSignedCowShedRegistration,
} from './registration.cow-shed'
import { getCowShedReadiness } from './registration.cow-shed.readiness'
import {
  COW_SHED_RETRY_WINDOW_MS,
  classifyCowShedFailure,
  getCowShedRetryDelay,
  normalizeCowShedOrderBookFailure,
} from './registration.cow-shed.retry'
import type { PendingEthSwap } from './registration.eth.actors'
import type { WalletProgress } from './registration.wallet-progress'

// Conservative estimate: 2m hook gas plus 500k settlement gas, not a simulation.
const SECOND_EXECUTION_GAS_UNITS = 2_500_000n

export const quoteCowShedPaymentActor = ResultFn(async function* (input: {
  readonly owner: Address
  readonly publicClient: PublicClient
  readonly chainId: number
  readonly registrationPrice: bigint
  readonly sellToken: CowSellToken
}) {
  const block = yield* fromPromise(input.publicClient.getBlock(), (cause) =>
    recoveryError(input.owner, cause),
  )
  const fees = yield* fromPromise(
    input.publicClient.estimateFeesPerGas(),
    (cause) => recoveryError(input.owner, cause),
  )
  const ethUsd = yield* readEthUsdPrice({
    publicClient: input.publicClient,
    chainId: input.chainId,
    nowSeconds: block.timestamp,
  })
  const executionBudget = estimateCowShedExecutionBudget({
    gasUnits: SECOND_EXECUTION_GAS_UNITS,
    gasPriceWei: fees.maxFeePerGas,
    ethUsd,
  })
  const { firstOrderValidTo, secondOrderValidTo } =
    yield* getCowShedQuoteValidity(block.timestamp).mapErr((cause) =>
      recoveryError(input.owner, cause),
    )
  const standIn = yield* fromPromise(
    prepareCowShedQuoteHooks({
      chainId: input.chainId,
      wallet: input.owner,
      resolver: input.owner,
      name: `${'a'.repeat(63)}.eth`,
      duration: 31_536_000n,
      secret: zeroHash,
      commitment: zeroHash,
      salt: zeroHash,
      setupNonce: zeroHash,
      registrationNonce: `0x${'11'.repeat(32)}`,
      registrationPrice: input.registrationPrice,
      executionBudget,
      firstOrderValidTo,
      secondOrderValidTo,
    }),
    (cause) => recoveryError(input.owner, cause),
  )
  const usdcToBuy = input.registrationPrice + executionBudget
  const swap = yield* quoteCowSwap({
    publicClient: input.publicClient,
    chainId: input.chainId,
    owner: input.owner,
    receiver: standIn.cowShedAccount,
    amountOut: usdcToBuy,
    sellToken: input.sellToken,
    fixedValidTo: Number(firstOrderValidTo),
    hooks: { post: [standIn.setupHook] },
  })
  return ok({
    usdcToBuy,
    swap,
    executionBudget,
    firstOrderValidTo: Number(firstOrderValidTo),
  })
})

export class CowShedRegistrationError extends TaggedError(
  'CowShedRegistrationError',
)<{
  readonly cause: unknown
  readonly message: string
  readonly cowShedAccount?: Address
}> {}

export type CowShedPlan = Readonly<{
  authorization: Omit<
    Parameters<typeof prepareSignedCowShedRegistration>[0],
    'publicClient' | 'walletClient' | 'onWalletProgress'
  >
  signed: Awaited<ReturnType<typeof prepareSignedCowShedRegistration>>
  sellToken: CowSellToken
  maximumSell: bigint
  funding?: PendingEthSwap
}>

export type CowShedProgress =
  | Readonly<{ stage: 'prepared'; plan: CowShedPlan }>
  | Readonly<{ stage: 'fundingSubmission'; plan: CowShedPlan }>
  | Readonly<{
      stage: 'fundingSent'
      plan: CowShedPlan
      funding: PendingEthSwap
    }>
  | Readonly<{ stage: 'funded'; plan: CowShedPlan }>
  | Readonly<{
      stage: 'publishing'
      plan: CowShedPlan
      request: CowConditionalOrderSubmission
      orderId: Hash
    }>
  | Readonly<{ stage: 'revealSent'; plan: CowShedPlan; orderId: string }>
  | Readonly<{ stage: 'settled'; plan: CowShedPlan; orderId?: string }>

export type RunCowShedRegistrationInput = Readonly<{
  publicClient: PublicClient
  walletClient: WalletClient
  chainId: number
  owner: Address
  name: string
  duration: bigint
  secret: Hash
  commitment: Hash
  resolver: Address
  referrer?: Hash
  registrationPrice: bigint
  executionBudget: bigint
  firstOrderValidTo: number
  secondOrderValidTo?: bigint
  maximumSell: bigint
  sellToken: CowSellToken
  salt: Hash
  setupNonce: Hash
  registrationNonce: Hash
  progress?: CowShedProgress
  onProgress: (progress: CowShedProgress) => Promise<void>
  onWalletProgress?: (progress: WalletProgress) => void
  signal?: AbortSignal
}>

const checkoutError = (cowShedAccount: Address, cause: unknown) =>
  new CowShedRegistrationError({
    cause,
    cowShedAccount,
    message: `The CoW payment was not submitted. Return to the quote to try again. ${cause instanceof Error ? cause.message : String(cause)}`,
  })

const recoveryError = (cowShedAccount: Address, cause: unknown) =>
  new CowShedRegistrationError({
    cause,
    cowShedAccount,
    message: `Registration needs recovery for CoW Shed ${cowShedAccount}. No new purchase will be made. ${cause instanceof Error ? cause.message : String(cause)}`,
  })

const fundingError = (cowShedAccount: Address, cause: unknown) =>
  cause instanceof CowSwapSubmissionError
    ? recoveryError(cowShedAccount, cause)
    : checkoutError(cowShedAccount, cause)

const SINGLE_ORDERS_ABI = parseAbi([
  'function singleOrders(address owner,bytes32 orderHash) view returns (bool)',
])
const COMMITMENT_AGE_ABI = parseAbi([
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
])
const POLL_INTERVAL_MS = 5_000
const COMMITMENT_VISIBILITY_WINDOW_MS = 30_000

const withOrderBookTransport = <T>(request: Promise<T>): Promise<T> =>
  request.catch((cause: unknown) =>
    Promise.reject(normalizeCowShedOrderBookFailure(cause)),
  )

const createRegistrationOrderBook = () => {
  const api = new OrderBookApi({
    chainId: SupportedChainId.SEPOLIA,
    // The runner must check cancellation and reconcile the UID before retrying.
    backoffOpts: { numOfAttempts: 1 },
  })
  return {
    getOrder: (...args: Parameters<OrderBookApi['getOrder']>) =>
      withOrderBookTransport(api.getOrder(...args)),
    uploadAppData: (...args: Parameters<OrderBookApi['uploadAppData']>) =>
      withOrderBookTransport(api.uploadAppData(...args)),
    sendOrder: (...args: Parameters<OrderBookApi['sendOrder']>) =>
      withOrderBookTransport(api.sendOrder(...args)),
  }
}

type CowShedOutcome = Readonly<{ cowShedAccount: Address; orderId?: string }>
type StageInput = RunCowShedRegistrationInput &
  Readonly<{ progress: CowShedProgress }>

const pause = (
  signal?: AbortSignal,
  delayMs = POLL_INTERVAL_MS,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
  })

const checkAbort = (input: StageInput) =>
  input.signal?.aborted
    ? err(
        (input.progress.stage === 'prepared' ? checkoutError : recoveryError)(
          input.progress.plan.signed.cowShedAccount,
          input.signal.reason,
        ),
      )
    : ok(undefined)

const retryOperation = ResultFn(async function* <T>(
  input: StageInput,
  operation: () => ResultAsync<T, CowShedRegistrationError>,
  deadline = Date.now() + COW_SHED_RETRY_WINDOW_MS,
  initialError?: CowShedRegistrationError,
  classifyFailure = classifyCowShedFailure,
) {
  for (let attempt = 0; ; attempt += 1) {
    yield* checkAbort(input)
    const result =
      attempt === 0 && initialError ? err(initialError) : await operation()
    yield* checkAbort(input)
    if (result.isOk()) return result
    const failure = classifyFailure(result.error, Date.now())
    if (failure.kind !== 'transient') return result
    const delay = getCowShedRetryDelay({
      attempt,
      now: Date.now(),
      deadline,
      retryAfterMs: failure.retryAfterMs,
    })
    if (delay === undefined) return result
    yield* fromPromise(pause(input.signal, delay), (cause) =>
      recoveryError(input.progress.plan.signed.cowShedAccount, cause),
    )
    if (Date.now() >= deadline) return result
  }
})

const readWithRetry = <T>(
  input: StageInput,
  operation: () => Promise<T>,
  deadline?: number,
) =>
  retryOperation(
    input,
    () =>
      fromPromise(operation(), (cause) =>
        (input.progress.stage === 'prepared' ? checkoutError : recoveryError)(
          input.progress.plan.signed.cowShedAccount,
          cause,
        ),
      ),
    deadline,
  )

const confirmNativeFundingCreation = ResultFn(async function* (
  input: StageInput,
  funding: PendingEthSwap,
) {
  if (funding.kind !== 'native' || !funding.hash) return ok(undefined)
  const hash = funding.hash
  const recover = (cause: unknown) =>
    recoveryError(input.progress.plan.signed.cowShedAccount, cause)
  const receipt = yield* retryOperation(
    input,
    () =>
      fromPromise(input.publicClient.getTransactionReceipt({ hash }), recover),
    undefined,
    undefined,
    (error, now) =>
      error instanceof CowShedRegistrationError &&
      error.cause instanceof TransactionReceiptNotFoundError
        ? { kind: 'transient' }
        : classifyCowShedFailure(error, now),
  )
  if (receipt.status !== 'success')
    return err(recover('The ETH funding creation transaction failed on-chain.'))
  input.onWalletProgress?.({ action: 'nativePayment', phase: 'completed' })
  return ok(undefined)
})

const saveProgress = ResultFn(async function* (
  input: RunCowShedRegistrationInput,
  progress: CowShedProgress,
) {
  if (input.signal?.aborted)
    return err(
      recoveryError(progress.plan.signed.cowShedAccount, input.signal.reason),
    )
  yield* fromPromise(input.onProgress(progress), (cause) =>
    recoveryError(progress.plan.signed.cowShedAccount, cause),
  )
  return ok(undefined)
})

const verifyAlreadyRegistered = (input: StageInput) => {
  const { authorization } = input.progress.plan
  const contracts = getDestinationContracts(authorization.chainId)
  return verifyRegistrationActor({
    publicClient: input.publicClient,
    name: authorization.name,
    owner: authorization.wallet,
    resolverAddress: authorization.resolver,
    commitment: authorization.commitment,
    registrarAddress: contracts.ethRegistrar,
    registryAddress: contracts.ethRegistry,
    graceWindowMs: 0,
    signal: input.signal,
  })
    .map(({ verified }) => verified)
    .mapErr((cause) =>
      recoveryError(input.progress.plan.signed.cowShedAccount, cause),
    )
}

const pollOrder = ResultFn(async function* (
  input: StageInput,
  orderId: string,
  validTo: number,
  isReveal: boolean,
) {
  const shed = input.progress.plan.signed.cowShedAccount
  const orderBook = createRegistrationOrderBook()
  while (true) {
    yield* checkAbort(input)
    const response = await fromPromise(
      orderBook.getOrder(orderId),
      (cause) => cause,
    )
    yield* checkAbort(input)
    const status = response.isOk() ? response.value.status : undefined
    if (status === OrderStatus.FULFILLED) return ok(undefined)
    if (isReveal && (yield* verifyAlreadyRegistered(input)))
      return ok(undefined)
    if (status === OrderStatus.CANCELLED || status === OrderStatus.EXPIRED)
      return err(recoveryError(shed, `Order ${orderId} is ${status}.`))
    const block = yield* readWithRetry(input, () =>
      input.publicClient.getBlock(),
    )
    if (block.timestamp > BigInt(validTo) + 120n) {
      return err(
        recoveryError(
          shed,
          `Order ${orderId} could not be confirmed before expiry.`,
        ),
      )
    }
    yield* fromPromise(pause(input.signal), (cause) =>
      recoveryError(shed, cause),
    )
  }
})

const readCowShedAuthorization = ResultFn(async function* (
  publicClient: PublicClient,
  plan: CowShedPlan,
  onError: (cause: unknown) => CowShedRegistrationError,
) {
  const { signed } = plan
  const orderHash = yield* Result.fromThrowable(
    () => getCowShedConditionalOrderHash(signed.conditionalOrder),
    onError,
  )()
  const isAuthorized = yield* fromPromise(
    publicClient.readContract({
      address: COMPOSABLE_COW,
      abi: SINGLE_ORDERS_ABI,
      functionName: 'singleOrders',
      args: [signed.cowShedAccount, orderHash],
    }),
    onError,
  )
  return ok(isAuthorized)
})

const canPublishRegistration = (
  input: Readonly<{
    isAuthorized: boolean
    balance: bigint
    requiredBalance: bigint
    livePrice: bigint
    authorizedPrice: bigint
  }>,
) =>
  input.isAuthorized &&
  input.balance >= input.requiredBalance &&
  input.livePrice <= input.authorizedPrice

const waitForReadyRegistration = ResultFn(async function* (
  input: StageInput,
  deadline?: number,
) {
  const { plan } = input.progress
  const { authorization, signed } = plan
  const contracts = getDestinationContracts(authorization.chainId)
  const recover = (cause: unknown) =>
    recoveryError(signed.cowShedAccount, cause)
  const visibilityDeadline = Date.now() + COMMITMENT_VISIBILITY_WINDOW_MS
  const read = <T>(operation: () => Promise<T>) =>
    readWithRetry(input, operation, deadline)
  while (true) {
    yield* checkAbort(input)
    const committedAt = yield* read(() =>
      input.publicClient.readContract({
        address: contracts.ethRegistrar,
        abi: ethRegistrarCommitmentsSnippet,
        functionName: 'commitmentAt',
        args: [authorization.commitment],
      }),
    )
    const minAge = yield* read(() =>
      input.publicClient.readContract({
        address: contracts.ethRegistrar,
        abi: COMMITMENT_AGE_ABI,
        functionName: 'MIN_COMMITMENT_AGE',
      }),
    )
    const maxAge = yield* read(() =>
      input.publicClient.readContract({
        address: contracts.ethRegistrar,
        abi: COMMITMENT_AGE_ABI,
        functionName: 'MAX_COMMITMENT_AGE',
      }),
    )
    const block = yield* read(() => input.publicClient.getBlock())
    const readiness = getCowShedReadiness({
      committedAt,
      minAge,
      maxAge,
      timestamp: block.timestamp,
      validTo: authorization.secondOrderValidTo,
    })
    switch (readiness) {
      case 'authorizationExpired':
        return err(recover('The registration authorization expired.'))
      case 'commitmentExpired':
        return err(recover('The registrar commitment expired.'))
      case 'missing': {
        if (yield* verifyAlreadyRegistered(input))
          return ok('registered' as const)
        if (block.timestamp > authorization.secondOrderValidTo)
          return err(recover('The registration authorization expired.'))
        const remaining = visibilityDeadline - Date.now()
        if (remaining <= 0)
          return err(
            recover('The funding order did not record the commitment.'),
          )
        yield* fromPromise(
          pause(input.signal, Math.min(POLL_INTERVAL_MS, remaining)),
          recover,
        )
        continue
      }
      case 'waiting':
        yield* fromPromise(pause(input.signal), recover)
        continue
      case 'ready':
        break
    }
    const liveAuthorization = yield* retryOperation(
      input,
      () => readCowShedAuthorization(input.publicClient, plan, recover),
      deadline,
    )
    const balance = yield* read(() =>
      input.publicClient.readContract({
        address: contracts.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [signed.cowShedAccount],
      }),
    )
    const [base, premium] = yield* read(() =>
      input.publicClient.readContract({
        address: contracts.ethRegistrar,
        abi: ethRegistrarGetRegisterPriceSnippet,
        functionName: 'getRegisterPrice',
        args: [
          authorization.name.replace(/\.eth$/, ''),
          authorization.duration,
          contracts.usdc,
        ],
      }),
    )
    if (
      !canPublishRegistration({
        isAuthorized: liveAuthorization,
        balance,
        requiredBalance: signed.firstOrderAmountOut,
        livePrice: base + premium,
        authorizedPrice: authorization.registrationPrice,
      })
    ) {
      return err(
        recover(
          'The authorization, Shed balance, or registration price changed.',
        ),
      )
    }
    return ok('ready' as const)
  }
})

const waitForOrderRequest = ResultFn(async function* (input: StageInput) {
  const { plan } = input.progress
  const recover = (cause: unknown) =>
    recoveryError(plan.signed.cowShedAccount, cause)
  let retryDeadline = Number.POSITIVE_INFINITY
  let attempt = 0
  while (true) {
    yield* checkAbort(input)
    const generated = await fromPromise(
      buildCowShedOrderRequest({
        publicClient: input.publicClient,
        owner: plan.signed.cowShedAccount,
        conditionalOrder: plan.signed.conditionalOrder,
      }),
      (cause) => cause,
    )
    yield* checkAbort(input)
    if (generated.isOk()) return ok(generated.value)
    const failure = classifyCowShedFailure(generated.error, Date.now())
    if (failure.kind === 'terminal') return err(recover(generated.error))
    if (failure.kind !== 'epoch') {
      retryDeadline = Math.min(
        retryDeadline,
        Date.now() + COW_SHED_RETRY_WINDOW_MS,
      )
      const delay = getCowShedRetryDelay({
        attempt,
        now: Date.now(),
        deadline: retryDeadline,
        retryAfterMs:
          failure.kind === 'transient' ? failure.retryAfterMs : undefined,
      })
      if (delay === undefined) return err(recover(generated.error))
      yield* fromPromise(pause(input.signal, delay), recover)
      if (Date.now() >= retryDeadline) return err(recover(generated.error))
      const readiness = yield* waitForReadyRegistration(input, retryDeadline)
      if (readiness === 'registered') return ok('registered' as const)
      attempt += 1
      continue
    }
    retryDeadline = Number.POSITIVE_INFINITY
    attempt = 0
    while (true) {
      yield* fromPromise(pause(input.signal), recover)
      const readiness = yield* waitForReadyRegistration(input)
      if (readiness === 'registered') return ok('registered' as const)
      const block = yield* readWithRetry(input, () =>
        input.publicClient.getBlock(),
      )
      if (block.timestamp >= failure.timestamp) break
    }
  }
})

const hasOrderBookErrorType = (cause: unknown, errorType: string): boolean =>
  cause instanceof OrderBookApiError &&
  typeof cause.body === 'object' &&
  cause.body !== null &&
  'errorType' in cause.body &&
  cause.body.errorType === errorType

const sendRevealRequest = ResultFn(async function* (input: {
  readonly api: Pick<OrderBookApi, 'sendOrder'>
  readonly request: CowConditionalOrderSubmission
  readonly orderId: string
  readonly shed: Address
}) {
  const posted = await fromPromise(
    input.api.sendOrder(input.request),
    (cause) => cause,
  )
  if (posted.isErr()) {
    return hasOrderBookErrorType(posted.error, 'DuplicatedOrder')
      ? ok(undefined)
      : err(recoveryError(input.shed, posted.error))
  }
  return posted.value.toLowerCase() === input.orderId.toLowerCase()
    ? ok(undefined)
    : err(
        recoveryError(
          input.shed,
          'The orderbook returned an unexpected order id.',
        ),
      )
})

const checkPublicationWindow = ResultFn(async function* (
  input: StageInput,
  deadline: number,
) {
  const block = yield* readWithRetry(
    input,
    () => input.publicClient.getBlock(),
    deadline,
  )
  if (
    block.timestamp > input.progress.plan.authorization.secondOrderValidTo ||
    Date.now() >= deadline
  )
    return err(
      recoveryError(
        input.progress.plan.signed.cowShedAccount,
        'The registration publication window expired.',
      ),
    )
  return checkAbort(input)
})

const recoverPublication = ResultFn(async function* (
  input: StageInput,
  progress: Extract<CowShedProgress, { stage: 'publishing' }>,
  deadline: number,
) {
  const { plan, orderId, request } = progress
  const shed = plan.signed.cowShedAccount
  const recover = (cause: unknown) => recoveryError(shed, cause)
  const api = createRegistrationOrderBook()
  const known = await fromPromise(api.getOrder(orderId), (cause) => cause)
  if (known.isOk()) return ok(known.value.status === OrderStatus.FULFILLED)
  if (
    !(known.error instanceof OrderBookApiError) ||
    known.error.response.status !== 404
  )
    return err(recover(known.error))
  const expectedId = yield* Result.fromThrowable(
    () => getCowShedOrderUid(request),
    recover,
  )()
  if (
    expectedId.toLowerCase() !== orderId.toLowerCase() ||
    !isAddressEqual(request.from, shed)
  )
    return err(recover('The saved publication request changed.'))
  yield* checkAbort(input)
  const readiness = yield* waitForReadyRegistration(input, deadline)
  if (readiness === 'registered') return ok(true)
  yield* checkAbort(input)
  yield* checkPublicationWindow(input, deadline)
  yield* sendRevealRequest({ api, request, orderId, shed })
  yield* checkAbort(input)
  yield* saveProgress(input, { stage: 'revealSent', plan, orderId })
  return ok(false)
})

const publishRegistration = ResultFn(async function* (
  input: StageInput,
  progress: Extract<CowShedProgress, { stage: 'publishing' }>,
  mode: 'publish' | 'recover',
) {
  const deadline = Date.now() + COW_SHED_RETRY_WINDOW_MS
  const reconcile = () => recoverPublication(input, progress, deadline)
  if (mode === 'recover')
    return ok(yield* retryOperation(input, reconcile, deadline))
  yield* checkPublicationWindow(input, deadline)
  const published = await sendRevealRequest({
    api: createRegistrationOrderBook(),
    request: progress.request,
    orderId: progress.orderId,
    shed: progress.plan.signed.cowShedAccount,
  })
  yield* checkAbort(input)
  if (published.isErr())
    return ok(
      yield* retryOperation(input, reconcile, deadline, published.error),
    )
  yield* saveProgress(input, {
    stage: 'revealSent',
    plan: progress.plan,
    orderId: progress.orderId,
  })
  return ok(false)
})

const resumeCowShedProgress = ResultFn(async function* (
  input: StageInput,
): AsyncGenerator<
  Err<never, CowShedRegistrationError>,
  Result<CowShedOutcome, CowShedRegistrationError>,
  never
> {
  yield* checkAbort(input)
  const { progress } = input
  const { plan } = progress
  const shed = plan.signed.cowShedAccount
  const recover = (cause: unknown) => recoveryError(shed, cause)
  if (progress.stage === 'fundingSubmission')
    return err(recover('Funding submission is ambiguous.'))
  if (progress.stage === 'settled')
    return ok({ cowShedAccount: shed, orderId: progress.orderId })
  if (progress.stage === 'prepared') {
    const rejectCheckout = (cause: unknown) => checkoutError(shed, cause)
    const block = yield* fromPromise(
      input.publicClient.getBlock(),
      rejectCheckout,
    )
    if (block.timestamp > plan.authorization.firstOrderValidTo)
      return err(rejectCheckout('The funding authorization expired.'))
    const authorization = yield* readCowShedAuthorization(
      input.publicClient,
      plan,
      rejectCheckout,
    )
    if (authorization)
      return err(rejectCheckout('This Shed already has a conditional order.'))
    yield* fromPromise(
      input.publicClient.call({
        account: plan.authorization.wallet,
        to: plan.signed.setupHook.target,
        data: plan.signed.setupHook.callData,
        gas: BigInt(plan.signed.setupHook.gasLimit),
      }),
      rejectCheckout,
    )
    yield* checkAbort(input)
    const submitted = yield* submitCowSwap({
      publicClient: input.publicClient,
      walletClient: input.walletClient,
      chainId: plan.authorization.chainId,
      owner: plan.authorization.wallet,
      receiver: shed,
      amountOut: plan.signed.firstOrderAmountOut,
      sellToken: plan.sellToken,
      maximumSell: plan.maximumSell,
      fixedValidTo: Number(plan.authorization.firstOrderValidTo),
      priceLimit: 'latestQuote',
      signal: input.signal,
      onWalletProgress: input.onWalletProgress,
      hooks: { post: [plan.signed.setupHook] },
      onBeforeOrderSubmission: () =>
        input.onProgress({ stage: 'fundingSubmission', plan }),
      onOrderSent: (funding) =>
        input.onProgress({
          stage: 'fundingSent',
          plan: { ...plan, funding },
          funding,
        }),
    }).mapErr((cause) => fundingError(shed, cause))
    return ok(
      yield* resumeCowShedProgress({
        ...input,
        progress: {
          stage: 'fundingSent',
          plan: { ...plan, funding: submitted.order },
          funding: submitted.order,
        },
      }),
    )
  }
  if (progress.stage === 'fundingSent') {
    yield* confirmNativeFundingCreation(input, progress.funding)
    yield* pollOrder(
      input,
      progress.funding.orderId,
      progress.funding.validTo,
      false,
    )
    const funded = {
      stage: 'funded',
      plan: { ...plan, funding: progress.funding },
    } as const
    yield* saveProgress(input, funded)
    return ok(yield* resumeCowShedProgress({ ...input, progress: funded }))
  }
  if (progress.stage === 'funded') {
    const readiness = yield* waitForReadyRegistration(input)
    if (readiness === 'registered') {
      yield* saveProgress(input, { stage: 'settled', plan })
      return ok({ cowShedAccount: shed })
    }
    const api = createRegistrationOrderBook()
    yield* readWithRetry(input, () =>
      api.uploadAppData(
        plan.signed.registrationAppData.appDataHex,
        plan.signed.registrationAppData.appDataContent,
      ),
    )
    const request = yield* waitForOrderRequest(input)
    if (request === 'registered') {
      yield* saveProgress(input, { stage: 'settled', plan })
      return ok({ cowShedAccount: shed })
    }
    const orderId = yield* Result.fromThrowable(
      () => getCowShedOrderUid(request),
      recover,
    )()
    const publishing = { stage: 'publishing', plan, request, orderId } as const
    yield* saveProgress(input, publishing)
    if (yield* publishRegistration(input, publishing, 'publish')) {
      yield* saveProgress(input, { stage: 'settled', plan, orderId })
      return ok({ cowShedAccount: shed, orderId })
    }
    const sent = { stage: 'revealSent', plan, orderId } as const
    return ok(yield* resumeCowShedProgress({ ...input, progress: sent }))
  }
  if (
    progress.stage === 'publishing' &&
    (yield* publishRegistration(input, progress, 'recover'))
  ) {
    yield* saveProgress(input, {
      stage: 'settled',
      plan,
      orderId: progress.orderId,
    })
    return ok({ cowShedAccount: shed, orderId: progress.orderId })
  }
  const orderId = progress.orderId
  yield* pollOrder(
    input,
    orderId,
    Number(plan.authorization.secondOrderValidTo),
    true,
  )
  yield* saveProgress(input, { stage: 'settled', plan, orderId })
  return ok({ cowShedAccount: shed, orderId })
})

const isMatchingCheckout = (
  input: RunCowShedRegistrationInput,
  plan: CowShedPlan,
): boolean => {
  const saved = plan.authorization
  return (
    saved.chainId === input.chainId &&
    isAddressEqual(saved.wallet, input.owner) &&
    saved.name === input.name &&
    saved.duration === input.duration &&
    isAddressEqual(saved.resolver, input.resolver) &&
    saved.commitment.toLowerCase() === input.commitment.toLowerCase() &&
    saved.secret.toLowerCase() === input.secret.toLowerCase() &&
    saved.referrer?.toLowerCase() === input.referrer?.toLowerCase() &&
    saved.registrationPrice === input.registrationPrice &&
    saved.executionBudget === input.executionBudget &&
    Number(saved.firstOrderValidTo) === input.firstOrderValidTo &&
    saved.secondOrderValidTo ===
      (input.secondOrderValidTo ?? BigInt(input.firstOrderValidTo) + 3_600n) &&
    plan.maximumSell === input.maximumSell &&
    isAddressEqual(plan.sellToken.address, input.sellToken.address) &&
    plan.sellToken.decimals === input.sellToken.decimals &&
    plan.sellToken.isNative === input.sellToken.isNative
  )
}

export const runCowShedRegistrationActor = ResultFn(async function* (
  input: RunCowShedRegistrationInput,
) {
  const connectedOwner = input.walletClient.account?.address
  if (
    input.chainId !== SupportedChainId.SEPOLIA ||
    input.publicClient.chain?.id !== input.chainId ||
    input.walletClient.chain?.id !== input.chainId ||
    !connectedOwner ||
    !isAddressEqual(connectedOwner, input.owner)
  ) {
    return err(
      recoveryError(
        input.progress?.plan.signed.cowShedAccount ?? input.owner,
        'Connect the original wallet on Sepolia.',
      ),
    )
  }
  if (input.progress) {
    if (!isMatchingCheckout(input, input.progress.plan)) {
      return err(
        recoveryError(
          input.progress.plan.signed.cowShedAccount,
          'This saved registration belongs to another checkout.',
        ),
      )
    }
    return ok(
      yield* resumeCowShedProgress({ ...input, progress: input.progress }),
    )
  }
  const shed = yield* Result.fromThrowable(
    () => getCowShedAddress({ chainId: input.chainId, wallet: input.owner }),
    (cause) => recoveryError(input.owner, cause),
  )()
  const recover = (cause: unknown) => recoveryError(shed, cause)
  if (input.signal?.aborted) return err(recover(input.signal.reason))
  const block = yield* fromPromise(input.publicClient.getBlock(), recover)
  if (block.timestamp > BigInt(input.firstOrderValidTo)) {
    return err(recover('The checkout quote expired.'))
  }
  const authorization: CowShedPlan['authorization'] = {
    chainId: input.chainId,
    wallet: input.owner,
    resolver: input.resolver,
    name: input.name,
    duration: input.duration,
    referrer: input.referrer,
    secret: input.secret,
    commitment: input.commitment,
    registrationPrice: input.registrationPrice,
    executionBudget: input.executionBudget,
    firstOrderValidTo: BigInt(input.firstOrderValidTo),
    secondOrderValidTo:
      input.secondOrderValidTo ?? BigInt(input.firstOrderValidTo) + 3_600n,
    salt: input.salt,
    setupNonce: input.setupNonce,
    registrationNonce: input.registrationNonce,
  }
  const signed = yield* fromPromise(
    prepareSignedCowShedRegistration({
      ...authorization,
      publicClient: input.publicClient,
      walletClient: input.walletClient,
      onWalletProgress: input.onWalletProgress,
    }),
    recover,
  )
  const plan: CowShedPlan = {
    authorization,
    signed,
    sellToken: input.sellToken,
    maximumSell: input.maximumSell,
  }
  const prepared = { stage: 'prepared', plan } as const
  yield* saveProgress(input, prepared)
  return ok(yield* resumeCowShedProgress({ ...input, progress: prepared }))
})
