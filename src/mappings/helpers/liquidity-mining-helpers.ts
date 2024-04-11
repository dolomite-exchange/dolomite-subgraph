/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */

import { Address, BigInt } from '@graphprotocol/graph-ts'
import { LiquidityMiningClaim, LiquidityMiningSeason, LiquidityMiningVestingPosition, Token } from '../../types/schema'
import { _18_BI, ARB_ADDRESS, ZERO_BD } from '../generated/constants'
import { getOrCreateEffectiveUserTokenValue } from './margin-helpers'
import { getRewardClaimerKey } from './event-emitter-registry-helpers'
import { convertTokenToDecimal } from './token-helpers'

export class LiquidityMiningVestingPositionStatus {
  public static ACTIVE: string = 'ACTIVE'
  public static CLOSED: string = 'CLOSED'
  public static FORCE_CLOSED: string = 'FORCE_CLOSED'
  public static EMERGENCY_CLOSED: string = 'EMERGENCY_CLOSED'
}

export function getLiquidityMiningSeasonId(distributor: Address, user: Address, season: BigInt): string {
  return `${distributor.toHexString()}-${user.toHexString()}-${season.toString()}`
}

export function handleVestingPositionClose(position: LiquidityMiningVestingPosition): void {
  let arbToken = Token.load(ARB_ADDRESS) as Token
  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, arbToken)
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.minus(position.arbAmountPar)
  effectiveUserTokenValue.save()
}

export function handleClaim(
  distributor: Address,
  user: Address,
  epoch: BigInt,
  seasonNumber: BigInt,
  amount: BigInt,
): void {
  let claim = new LiquidityMiningClaim(getRewardClaimerKey(distributor, user, epoch))
  claim.distributor = distributor
  claim.user = user.toHexString()
  claim.epoch = epoch.toI32()
  claim.seasonNumber = seasonNumber.toI32()
  claim.amount = convertTokenToDecimal(amount, _18_BI)
  claim.save()

  let seasonId = getLiquidityMiningSeasonId(distributor, user, seasonNumber)
  let season = LiquidityMiningSeason.load(seasonId)
  if (season === null) {
    season = new LiquidityMiningSeason(seasonId)
    season.distributor = distributor
    season.user = claim.user
    season.seasonNumber = seasonNumber.toI32()
    season.totalClaimAmount = ZERO_BD
  }
  season.totalClaimAmount = season.totalClaimAmount.plus(claim.amount)
  season.save()
}
