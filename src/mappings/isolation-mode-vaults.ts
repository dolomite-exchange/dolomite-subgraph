import { VaultCreated as VaultCreatedEvent } from '../types/templates/IsolationModeVault/IsolationModeFactory'
import { IsolationModeVaultReverseLookup, Token, User } from '../types/schema'

import { createUserIfNecessary } from './helpers/user-helpers'

export function handleVaultCreated(event: VaultCreatedEvent): void {
  createUserIfNecessary(event.params.vault)
  createUserIfNecessary(event.params.account)

  let vaultUser = User.load(event.params.vault.toHexString()) as User
  vaultUser.effectiveUser = event.params.account.toHexString()
  vaultUser.save()

  let token = Token.load(event.address.toHexString()) as Token
  let vaultMap = new IsolationModeVaultReverseLookup(event.params.vault.toHexString())
  vaultMap.token = token.id
  vaultMap.vault = event.params.vault.toHexString()
  vaultMap.owner = event.params.account.toHexString()
  vaultMap.save()
}
