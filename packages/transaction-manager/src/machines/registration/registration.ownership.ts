import { type Address, isAddressEqual, zeroAddress } from 'viem'

const STATUS_REGISTERED = 2

export function getRegistrationOwnership(input: {
  readonly state: {
    readonly status: number
    readonly latestOwner: Address
  }
  readonly expectedOwner: Address
}): {
  readonly owner: Address
  readonly registeredToOther: boolean
  readonly isUnregistered: boolean
} {
  // Non-registered entries can retain an expired registration's owner.
  const owner =
    input.state.status === STATUS_REGISTERED
      ? input.state.latestOwner
      : zeroAddress
  return {
    owner,
    registeredToOther:
      !isAddressEqual(owner, zeroAddress) &&
      !isAddressEqual(owner, input.expectedOwner),
    isUnregistered: isAddressEqual(owner, zeroAddress),
  }
}
