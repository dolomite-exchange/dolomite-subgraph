/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */

import { Address } from '@graphprotocol/graph-ts'
import { LiquidityMiningVestingPosition, Token } from '../../types/schema'
import { ARB_ADDRESS } from '../generated/constants'
import { getOrCreateEffectiveUserTokenValue } from './margin-helpers'

export class LiquidityMiningVestingPositionStatus {
  public static ACTIVE: string = 'ACTIVE'
  public static CLOSED: string = 'CLOSED'
  public static FORCE_CLOSED: string = 'FORCE_CLOSED'
  public static EMERGENCY_CLOSED: string = 'EMERGENCY_CLOSED'
}

export function getLiquidityMiningSeasonId(userAddress: Address, seasonNumber: number): string {
  return `${userAddress.toHexString()}-${seasonNumber}`
}

export function handleVestingPositionClose(position: LiquidityMiningVestingPosition): void {
  let arbToken = Token.load(ARB_ADDRESS) as Token
  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, arbToken)
  effectiveUserTokenValue.totalParValue = effectiveUserTokenValue.totalParValue.minus(position.arbAmountPar)
  effectiveUserTokenValue.save()
}
