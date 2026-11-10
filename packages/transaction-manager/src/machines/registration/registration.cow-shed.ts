import {
  AppDataSdk,
  BuyTokenDestination,
  OrderKind,
  SellTokenSource,
  SigningScheme,
  SupportedChainId,
} from '@cowprotocol/cow-sdk'
import { COW_SHED_PROXY_INIT_CODE, CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { getDestinationContracts } from '@ens-apps/smart-account'
import { TaggedError } from '@ens-apps/utils/neverthrow'
import { err, ok, type Result } from 'neverthrow'
import {
  type Address,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getCreate2Address,
  type Hash,
  hashTypedData,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  type PublicClient,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  type WalletClient,
  zeroHash,
} from 'viem'
import { encodeRegisterCall } from './registration.actors'
import type { WalletProgress } from './registration.wallet-progress'

const FIRST_ORDER_LIFETIME_SECONDS = 300n
const SECOND_ORDER_LIFETIME_SECONDS = 3_600n
const MAX_ORDER_VALID_TO = 4_294_967_295n

class CowShedQuoteValidityError extends TaggedError(
  'CowShedQuoteValidityError',
)<{
  readonly cause: unknown
}> {}

export const getCowShedQuoteValidity = (
  timestamp: bigint,
): Result<
  Readonly<{ firstOrderValidTo: bigint; secondOrderValidTo: bigint }>,
  CowShedQuoteValidityError
> => {
  const firstOrderValidTo = timestamp + FIRST_ORDER_LIFETIME_SECONDS
  const secondOrderValidTo = firstOrderValidTo + SECOND_ORDER_LIFETIME_SECONDS
  return timestamp < 0n || secondOrderValidTo > MAX_ORDER_VALID_TO
    ? err(
        new CowShedQuoteValidityError({
          cause:
            'The block timestamp is outside the CoW order validity window.',
        }),
      )
    : ok({ firstOrderValidTo, secondOrderValidTo })
}

export const ENS_COMMITMENT = '0x7A383Ef8eaBA234c82a4a7dD20686a6314F41fF1'
export const COMPOSABLE_COW: Address =
  '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74'
const VAULT_RELAYER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
const MINIMUM_EXECUTION_BUDGET_USDC = 1_000_000n
const MINIMUM_BUY_AMOUNT_USDC = 1n
// First use must also deploy the Shed proxy.
const SETUP_HOOK_GAS_LIMIT = 3_000_000n
const ORDER_PARAMETERS = parseAbiParameters(
  '(address registrar,bytes32 commitment,address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 minSellBalance,uint256 endTime,bytes32 appData)',
)
const COMMIT_ABI = parseAbi(['function commit(bytes32 commitment)'])
const AUTHORIZATION_ABI = parseAbi([
  'function create((address handler,bytes32 salt,bytes staticInput) params,bool dispatch)',
])
const FACTORY_OPTIONS = {
  factoryAddress: '0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca',
  implementationAddress: '0xf0d400089d5b9faca64e3422ad6614546587cffb',
  domainVersion: '2.1.0',
} as const
const CONDITIONAL_PARAMETERS = parseAbiParameters(
  '(address handler,bytes32 salt,bytes staticInput)',
)

const requireSepolia = (chainId: number) => {
  if (chainId !== SupportedChainId.SEPOLIA) {
    throw new Error('ComposableCoW registration is only available on Sepolia.')
  }
}

const requireSepoliaClients = (input: {
  readonly chainId: number
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
}) => {
  requireSepolia(input.chainId)
  if (
    input.publicClient.chain?.id !== input.chainId ||
    input.walletClient.chain?.id !== input.chainId
  ) {
    throw new Error('CoW Shed signing requires Sepolia clients.')
  }
}

export const getCowShedAddress = (input: {
  readonly chainId: number
  readonly wallet: Address
}): Address => {
  requireSepolia(input.chainId)
  return getCreate2Address({
    from: FACTORY_OPTIONS.factoryAddress,
    salt: encodeAbiParameters(parseAbiParameters('address'), [input.wallet]),
    bytecodeHash: keccak256(
      concat([
        COW_SHED_PROXY_INIT_CODE['2.1.0'],
        encodeAbiParameters(parseAbiParameters('address,address'), [
          FACTORY_OPTIONS.implementationAddress,
          input.wallet,
        ]),
      ]),
    ),
  })
}

export const getCowShedConditionalOrderHash = (params: {
  readonly handler: Address
  readonly salt: Hash
  readonly staticInput: `0x${string}`
}): Hash => keccak256(encodeAbiParameters(CONDITIONAL_PARAMETERS, [params]))

const call = (target: Address, callData: `0x${string}`) => ({
  target,
  callData,
  value: 0n,
  allowFailure: false,
  isDelegateCall: false,
})

export const prepareCowShedRegistration = (input: {
  readonly chainId: number
  readonly wallet: Address
  readonly resolver: Address
  readonly name: string
  readonly duration: bigint
  readonly referrer?: Hash
  readonly secret: Hash
  readonly commitment: Hash
  readonly registrationPrice: bigint
  readonly executionBudget: bigint
  readonly firstOrderValidTo: bigint
  readonly secondOrderValidTo: bigint
  readonly appDataHash: Hash
  readonly salt: Hash
}) => {
  requireSepolia(input.chainId)
  if (
    input.registrationPrice <= 0n ||
    input.executionBudget <= 0n ||
    input.firstOrderValidTo <= 0n ||
    input.secondOrderValidTo <= input.firstOrderValidTo ||
    input.secondOrderValidTo > 4_294_967_295n
  ) {
    throw new Error(
      'The CoW Shed registration amounts or validity window are invalid.',
    )
  }
  const contracts = getDestinationContracts(input.chainId)
  const firstOrderAmountOut = input.registrationPrice + input.executionBudget
  const conditionalOrder = {
    handler: ENS_COMMITMENT,
    salt: input.salt,
    staticInput: encodeAbiParameters(ORDER_PARAMETERS, [
      {
        registrar: contracts.ethRegistrar,
        commitment: input.commitment,
        sellToken: contracts.usdc,
        buyToken: contracts.usdc,
        receiver: input.wallet,
        sellAmount: input.executionBudget,
        minSellBalance: firstOrderAmountOut,
        endTime: input.secondOrderValidTo,
        appData: input.appDataHash,
      },
    ]),
  } as const
  const register = encodeRegisterCall({
    name: input.name,
    owner: input.wallet,
    secret: input.secret,
    duration: input.duration,
    referrer: input.referrer,
    paymentToken: contracts.usdc,
    resolverAddress: input.resolver,
    registrarAddress: contracts.ethRegistrar,
  })
  return {
    firstOrderAmountOut,
    conditionalOrder,
    setupCalls: [
      call(
        contracts.ethRegistrar,
        encodeFunctionData({
          abi: COMMIT_ABI,
          functionName: 'commit',
          args: [input.commitment],
        }),
      ),
      call(
        COMPOSABLE_COW,
        encodeFunctionData({
          abi: AUTHORIZATION_ABI,
          functionName: 'create',
          args: [conditionalOrder, true],
        }),
      ),
      call(
        contracts.usdc,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [VAULT_RELAYER, input.executionBudget],
        }),
      ),
    ],
    registrationCalls: [
      call(
        contracts.usdc,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.ethRegistrar, 0n],
        }),
      ),
      call(
        contracts.usdc,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.ethRegistrar, input.registrationPrice],
        }),
      ),
      // A failed public invocation must roll back hook nonce consumption.
      call(register.to, register.data),
      call(
        contracts.usdc,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.ethRegistrar, 0n],
        }),
      ),
      call(
        contracts.usdc,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [VAULT_RELAYER, 0n],
        }),
      ),
    ],
  }
}

/** Sign calls for the ComposableCoW-compatible Shed rather than the ordinary Shed. */
export const signCowShedCalls = async (input: {
  readonly chainId: number
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly calls: readonly {
    readonly target: Address
    readonly callData: `0x${string}`
    readonly value: bigint
    readonly allowFailure: boolean
    readonly isDelegateCall: boolean
  }[]
  readonly nonce: Hash
  readonly deadline: bigint
  readonly gasLimit: bigint
}) => {
  requireSepoliaClients(input)
  const adapter = new ViemAdapter({
    provider: input.publicClient,
    walletClient: input.walletClient,
  })
  const sdk = new CowShedSdk(adapter, FACTORY_OPTIONS, '2.1.0')
  const signed = await sdk.signCalls({
    chainId: 11155111,
    calls: input.calls.map((item) => ({ ...item })),
    nonce: input.nonce,
    deadline: input.deadline,
    gasLimit: input.gasLimit,
  })
  if (
    !isAddress(signed.cowShedAccount) ||
    !isAddress(signed.signedMulticall.to) ||
    !isHex(signed.signedMulticall.data)
  ) {
    throw new Error('The CoW Shed SDK returned invalid call data.')
  }
  return {
    cowShedAccount: signed.cowShedAccount,
    signedMulticall: {
      ...signed.signedMulticall,
      to: signed.signedMulticall.to,
      data: signed.signedMulticall.data,
    },
    gasLimit: signed.gasLimit,
  }
}

/** Bind the signed registration call to the conditional order's app-data hash. */
export const createCowShedHookAppData = async (input: {
  readonly target: Address
  readonly callData: `0x${string}`
  readonly gasLimit: number
}) => {
  const sdk = new AppDataSdk()
  const doc = await sdk.generateAppDataDoc({
    appCode: 'ens-app',
    metadata: {
      hooks: {
        version: '0.2.0',
        post: [
          {
            target: input.target,
            callData: input.callData,
            gasLimit: input.gasLimit.toString(),
          },
        ],
      },
    },
  })
  const appDataContent = JSON.stringify(doc)
  return { appDataContent, appDataHex: keccak256(stringToHex(appDataContent)) }
}

export const COW_TRADEABLE_ORDER_ABI = parseAbi([
  'error PollTryAtEpoch(uint256 timestamp,string reason)',
  'error PollTryNextBlock(string reason)',
  'error PollNever(string reason)',
  'error OrderNotValid(string reason)',
  'function getTradeableOrderWithSignature(address owner,(address handler,bytes32 salt,bytes staticInput) params,bytes offchainInput,bytes32[] proof) view returns ((address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,bytes32 kind,bool partiallyFillable,bytes32 sellTokenBalance,bytes32 buyTokenBalance) order,bytes signature)',
])

export type CowConditionalOrderSubmission = Readonly<{
  from: Address
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: Hash
  feeAmount: string
  kind: OrderKind.SELL
  partiallyFillable: boolean
  sellTokenBalance: SellTokenSource.ERC20
  buyTokenBalance: BuyTokenDestination.ERC20
  signingScheme: SigningScheme.EIP1271
  signature: `0x${string}`
}>

/** Build the authorized conditional order with the agreed one-unit minimum. */
export const buildCowShedOrderRequest = async (input: {
  readonly publicClient: PublicClient
  readonly owner: Address
  readonly conditionalOrder: {
    readonly handler: Address
    readonly salt: Hash
    readonly staticInput: `0x${string}`
  }
}) => {
  requireSepolia(input.publicClient.chain?.id ?? 0)
  if (!isAddressEqual(input.conditionalOrder.handler, ENS_COMMITMENT)) {
    throw new Error('The conditional order has invalid authorization.')
  }
  const [expected] = decodeAbiParameters(
    ORDER_PARAMETERS,
    input.conditionalOrder.staticInput,
  )
  const [order, signature] = await input.publicClient.readContract({
    address: COMPOSABLE_COW,
    abi: COW_TRADEABLE_ORDER_ABI,
    functionName: 'getTradeableOrderWithSignature',
    args: [input.owner, input.conditionalOrder, '0x', []],
  })
  if (
    order.buyAmount !== MINIMUM_BUY_AMOUNT_USDC ||
    order.feeAmount !== 0n ||
    order.partiallyFillable ||
    !isAddressEqual(order.sellToken, expected.sellToken) ||
    !isAddressEqual(order.buyToken, expected.buyToken) ||
    !isAddressEqual(order.receiver, expected.receiver) ||
    order.sellAmount !== expected.sellAmount ||
    BigInt(order.validTo) !== expected.endTime ||
    order.appData.toLowerCase() !== expected.appData.toLowerCase() ||
    order.kind !== keccak256(stringToHex('sell')) ||
    order.sellTokenBalance !== keccak256(stringToHex('erc20')) ||
    order.buyTokenBalance !== keccak256(stringToHex('erc20'))
  ) {
    throw new Error('The conditional order has unexpected terms.')
  }
  return {
    from: input.owner,
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    validTo: order.validTo,
    appData: order.appData,
    feeAmount: order.feeAmount.toString(),
    kind: OrderKind.SELL,
    partiallyFillable: order.partiallyFillable,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    signingScheme: SigningScheme.EIP1271,
    signature,
  } satisfies CowConditionalOrderSubmission
}

export const getCowShedOrderUid = (
  request: CowConditionalOrderSubmission,
): Hash => {
  const orderHash = hashTypedData({
    domain: {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: SupportedChainId.SEPOLIA,
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
      ...request,
      sellAmount: BigInt(request.sellAmount),
      buyAmount: BigInt(request.buyAmount),
      feeAmount: BigInt(request.feeAmount),
    },
  })
  return concat([
    orderHash,
    request.from.toLowerCase() as Address,
    `0x${request.validTo.toString(16).padStart(8, '0')}`,
  ])
}

/** Convert the second settlement's gas budget into six-decimal USDC. */
export const estimateCowShedExecutionBudget = (input: {
  readonly gasUnits: bigint
  readonly gasPriceWei: bigint
  /** ETH/USD with eight decimals. */
  readonly ethUsd: bigint
}) => {
  const scale = 10n ** 20n
  const value = input.gasUnits * input.gasPriceWei * input.ethUsd * 2n
  const budget = (value + scale - 1n) / scale + MINIMUM_BUY_AMOUNT_USDC
  return budget > MINIMUM_EXECUTION_BUDGET_USDC
    ? budget
    : MINIMUM_EXECUTION_BUDGET_USDC
}

/** Build the same hook payload sizes for quoting, without wallet authorization. */
export const prepareCowShedQuoteHooks = async (
  input: Omit<
    Parameters<typeof prepareSignedCowShedRegistration>[0],
    'publicClient' | 'walletClient'
  >,
) => {
  requireSepolia(input.chainId)
  const initial = prepareCowShedRegistration({
    ...input,
    appDataHash: zeroHash,
  })
  const encodeHook = (
    calls: typeof initial.setupCalls,
    nonce: Hash,
    deadline: bigint,
    gasLimit: number,
  ) => ({
    target: FACTORY_OPTIONS.factoryAddress,
    callData: encodeFunctionData({
      abi: parseAbi([
        'function executeHooks((address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)[] calls,bytes32 nonce,uint256 deadline,address owner,bytes signature)',
      ]),
      functionName: 'executeHooks',
      args: [calls, nonce, deadline, input.wallet, `0x${'11'.repeat(65)}`],
    }),
    gasLimit,
  })
  const registrationHook = encodeHook(
    initial.registrationCalls,
    input.registrationNonce,
    input.secondOrderValidTo,
    2_000_000,
  )
  const registrationAppData = await createCowShedHookAppData(registrationHook)
  const prepared = prepareCowShedRegistration({
    ...input,
    appDataHash: registrationAppData.appDataHex,
  })
  return {
    cowShedAccount: getCowShedAddress(input),
    firstOrderAmountOut: prepared.firstOrderAmountOut,
    conditionalOrder: prepared.conditionalOrder,
    registrationAppData,
    registrationHook,
    setupHook: encodeHook(
      prepared.setupCalls,
      input.setupNonce,
      input.firstOrderValidTo,
      Number(SETUP_HOOK_GAS_LIMIT),
    ),
  }
}

/** Prepare both authorized Shed calls before submitting the first order. */
export const prepareSignedCowShedRegistration = async (
  input: Omit<
    Parameters<typeof prepareCowShedRegistration>[0],
    'appDataHash'
  > & {
    readonly publicClient: PublicClient
    readonly walletClient: WalletClient
    readonly setupNonce: Hash
    readonly registrationNonce: Hash
    readonly onWalletProgress?: (progress: WalletProgress) => void
  },
) => {
  requireSepoliaClients(input)
  if (
    !input.walletClient.account ||
    !isAddressEqual(input.walletClient.account.address, input.wallet)
  ) {
    throw new Error('The connected wallet does not own this CoW Shed.')
  }
  if (input.setupNonce === input.registrationNonce) {
    throw new Error('The CoW Shed hooks must use distinct nonces.')
  }
  const initial = prepareCowShedRegistration({
    ...input,
    appDataHash: `0x${'00'.repeat(32)}`,
  })
  input.onWalletProgress?.({
    action: 'registrationHook',
    phase: 'awaitingSignature',
  })
  const registration = await signCowShedCalls({
    chainId: input.chainId,
    publicClient: input.publicClient,
    walletClient: input.walletClient,
    calls: initial.registrationCalls,
    nonce: input.registrationNonce,
    deadline: input.secondOrderValidTo,
    gasLimit: 2_000_000n,
  })
  input.onWalletProgress?.({ action: 'registrationHook', phase: 'completed' })
  const registrationHook = {
    target: registration.signedMulticall.to,
    callData: registration.signedMulticall.data,
    gasLimit: Number(registration.gasLimit),
  }
  const registrationAppData = await createCowShedHookAppData(registrationHook)
  const prepared = prepareCowShedRegistration({
    ...input,
    appDataHash: registrationAppData.appDataHex,
  })
  input.onWalletProgress?.({ action: 'setupHook', phase: 'awaitingSignature' })
  const setup = await signCowShedCalls({
    chainId: input.chainId,
    publicClient: input.publicClient,
    walletClient: input.walletClient,
    calls: prepared.setupCalls,
    nonce: input.setupNonce,
    deadline: input.firstOrderValidTo,
    gasLimit: SETUP_HOOK_GAS_LIMIT,
  })
  input.onWalletProgress?.({ action: 'setupHook', phase: 'completed' })
  if (!isAddressEqual(setup.cowShedAccount, registration.cowShedAccount)) {
    throw new Error('The CoW Shed hooks refer to different accounts.')
  }
  return {
    cowShedAccount: setup.cowShedAccount,
    firstOrderAmountOut: prepared.firstOrderAmountOut,
    conditionalOrder: prepared.conditionalOrder,
    registrationAppData,
    registrationHook,
    setupHook: {
      target: setup.signedMulticall.to,
      callData: setup.signedMulticall.data,
      gasLimit: Number(setup.gasLimit),
    },
  }
}
