export const getCowShedReadiness = (
  input: Readonly<{
    timestamp: bigint
    committedAt: bigint
    minAge: bigint
    maxAge: bigint
    validTo: bigint
  }>,
) => {
  if (input.committedAt === 0n) return 'missing'
  if (input.timestamp > input.validTo) return 'authorizationExpired'
  if (input.timestamp >= input.committedAt + input.maxAge)
    return 'commitmentExpired'
  if (input.timestamp < input.committedAt + input.minAge) return 'waiting'
  return 'ready'
}
