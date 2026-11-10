import {
  type Address,
  HttpRequestError,
  type PublicClient,
  zeroAddress,
  zeroHash,
} from 'viem'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyCowShedRegistrationActor } from './registration.cow-shed.verification'

const rpc = vi.hoisted(() => ({ readContract: vi.fn(), multicall: vi.fn() }))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  ...rpc,
}))

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const RESOLVER: Address = '0x2222222222222222222222222222222222222222'
const REGISTRAR: Address = '0x3333333333333333333333333333333333333333'
const REGISTRY: Address = '0x4444444444444444444444444444444444444444'
const input = {
  name: 'example.eth',
  owner: OWNER,
  resolverAddress: RESOLVER,
  registrarAddress: REGISTRAR,
  registryAddress: REGISTRY,
  commitment: zeroHash,
  publicClient: {} as PublicClient,
}
const registryEntry = (status = 2) => [
  RESOLVER,
  { status, latestOwner: OWNER, expiry: 0n, tokenId: 0n, resource: 0n },
  zeroAddress,
]
const transportError = () =>
  new HttpRequestError({ url: 'https://rpc.example', status: 503 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  rpc.readContract.mockReset().mockResolvedValue(0n)
  rpc.multicall.mockReset().mockResolvedValue(registryEntry())
})

afterEach(() => vi.useRealTimers())

describe('verifyCowShedRegistrationActor', () => {
  it('retries a transport failure and verifies the registration on chain', async () => {
    rpc.multicall.mockRejectedValueOnce(transportError())
    const pending = verifyCowShedRegistrationActor(input)
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: true,
      registeredToOther: false,
      isUnregistered: false,
    })
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
  })

  it('shares the deadline between a transport retry and unregistered grace polling', async () => {
    rpc.multicall
      .mockResolvedValue(registryEntry(0))
      .mockRejectedValueOnce(transportError())
    const pending = verifyCowShedRegistrationActor(input)
    const settled = vi.fn()
    void pending.then(settled)

    await vi.advanceTimersByTimeAsync(119_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: false,
      registeredToOther: false,
      isUnregistered: true,
      reason: expect.stringContaining('owner'),
    })
    expect(settled).toHaveBeenCalledOnce()
    expect(Date.now()).toBe(120_000)
  })

  it('returns the original transport error when retries exhaust the overall deadline', async () => {
    const error = transportError()
    rpc.multicall.mockRejectedValue(error)
    const pending = verifyCowShedRegistrationActor(input)
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await pending
    const readsAtDeadline = rpc.multicall.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)

    assert(result.isErr())
    expect(result.error).toBe(error)
    expect(readsAtDeadline).toBe(9)
    expect(rpc.multicall).toHaveBeenCalledTimes(readsAtDeadline)
  })

  it('returns permanent read errors without retrying or reporting an unregistered name', async () => {
    const error = new Error('Invalid registry response')
    rpc.multicall.mockRejectedValue(error)
    const result = await verifyCowShedRegistrationActor(input)
    await vi.advanceTimersByTimeAsync(120_000)

    assert(result.isErr())
    expect(result.error).toBe(error)
    expect(rpc.multicall).toHaveBeenCalledOnce()
  })

  it('stops a transport retry pause immediately on abort without another read', async () => {
    const error = transportError()
    const controller = new AbortController()
    const reason = new Error('Registration cancelled')
    rpc.multicall.mockRejectedValue(error)
    const pending = verifyCowShedRegistrationActor({
      ...input,
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort(reason)
    const result = await pending
    await vi.advanceTimersByTimeAsync(120_000)

    assert(result.isErr())
    expect(result.error).toBe(reason)
    expect(rpc.multicall).toHaveBeenCalledOnce()
  })

  it('returns the abort reason when cancellation occurs during a successful registry read', async () => {
    const controller = new AbortController()
    const reason = new Error('Registration cancelled')
    rpc.multicall.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(registryEntry()), 1_000),
        ),
    )
    const pending = verifyCowShedRegistrationActor({
      ...input,
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(500)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(500)
    const result = await pending

    assert(result.isErr())
    expect(result.error).toBe(reason)
    expect(rpc.multicall).toHaveBeenCalledOnce()
  })

  it('verifies a CoW registration that confirms after the normal 30 second grace window', async () => {
    rpc.multicall.mockImplementation(async () =>
      registryEntry(Date.now() < 45_000 ? 0 : 2),
    )
    const pending = verifyCowShedRegistrationActor(input)
    const settled = vi.fn()
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    const result = await pending

    assert(result.isOk())
    expect(result.value).toEqual({
      verified: true,
      registeredToOther: false,
      isUnregistered: false,
    })
  })

  it('keeps a zero grace check single-shot even for a transient transport failure', async () => {
    const error = transportError()
    rpc.multicall.mockRejectedValue(error)
    const result = await verifyCowShedRegistrationActor({
      ...input,
      graceWindowMs: 0,
    })

    assert(result.isErr())
    expect(result.error).toBe(error)
    expect(rpc.multicall).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
