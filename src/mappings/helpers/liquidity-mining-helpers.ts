/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */

import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import {
  LiquidityMiningClaim,
  LiquidityMiningSeason,
  LiquidityMiningVester,
  LiquidityMiningVestingPosition,
  Token,
} from '../../types/schema'
import { _18_BI, ZERO_BD } from '../generated/constants'
import { getOrCreateEffectiveUserTokenValue } from './margin-helpers'
import { getRewardClaimerKey } from './event-emitter-registry-helpers'
import { convertTokenToDecimal } from './token-helpers'
import { createUserIfNecessary } from './user-helpers'

export class LiquidityMiningVestingPositionStatus {
  public static ACTIVE: string = 'ACTIVE'
  public static CLOSED: string = 'CLOSED'
  public static FORCE_CLOSED: string = 'FORCE_CLOSED'
  public static EMERGENCY_CLOSED: string = 'EMERGENCY_CLOSED'
}

export function getVestingPositionId(event: ethereum.Event, tokenId: BigInt): string {
  return `${event.address.toHexString()}-${tokenId.toString()}`
}

export function getVestingPosition(event: ethereum.Event, tokenId: BigInt): LiquidityMiningVestingPosition {
  return LiquidityMiningVestingPosition.load(getVestingPositionId(event, tokenId)) as LiquidityMiningVestingPosition
}

export function getLiquidityMiningSeasonId(distributor: Address, user: Address, season: BigInt): string {
  return `${distributor.toHexString()}-${user.toHexString()}-${season.toString()}`
}

export function handleVestingPositionClose(position: LiquidityMiningVestingPosition): void {
  let vester = LiquidityMiningVester.load(position.vester) as LiquidityMiningVester
  let pairToken = Token.load(vester.pairToken) as Token
  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, pairToken)
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.minus(position.pairAmountPar)
  effectiveUserTokenValue.save()
}

export function handleClaim(
  distributor: Address,
  user: Address,
  epoch: BigInt,
  seasonNumber: BigInt,
  amount: BigInt,
): void {
  createUserIfNecessary(user)

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
