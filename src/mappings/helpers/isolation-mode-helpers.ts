import { Address } from '@graphprotocol/graph-ts'
import { User } from '../../types/schema'

export function getEffectiveUserForAddress(vaultAddress: Address): User {
  let user = User.load(vaultAddress.toHexString()) as User
  return User.load(user.effectiveUser) as User
}

export function getEffectiveUserForAddressString(vaultAddress: string): User {
  return getEffectiveUserForAddress(Address.fromString(vaultAddress))
}
