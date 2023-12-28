import {
  EmergencyWithdraw as VestingPositionEmergencyWithdrawEvent,
  LevelRequestFinalized as LevelRequestFinalizedEvent,
  LevelRequestInitiated as LevelRequestInitiatedEvent,
  PositionClosed as VestingPositionClosedEvent,
  PositionDurationExtended as VestingPositionDurationExtendedEvent,
  PositionForceClosed as VestingPositionForceClosedEvent,
  Transfer as LiquidityMiningVestingPositionTransferEvent,
  VestingPositionCreated as VestingPositionCreatedEvent,
} from '../types/LiquidityMiningVester/LiquidityMiningVester'
import { Claimed as OARBClaimedEvent } from '../types/LiquidityMiningClaimer/LiquidityMiningClaimer'
import {
  InterestIndex,
  LiquidityMiningClaim,
  LiquidityMiningLevelUpdateRequest,
  LiquidityMiningSeason,
  LiquidityMiningVestingPosition,
  LiquidityMiningVestingPositionTransfer,
  Token,
} from '../types/schema'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { _18_BI, ADDRESS_ZERO, ARB_ADDRESS, ONE_BI, ZERO_BD } from './generated/constants'
import {
  getLiquidityMiningSeasonId,
  handleVestingPositionClose,
  LiquidityMiningVestingPositionStatus,
} from './helpers/liquidity-mining-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'
import {
  getOrCreateDolomiteMarginForCall,
  getOrCreateEffectiveUserTokenValue,
  weiToPar,
} from './helpers/margin-helpers'
import { ProtocolType } from './helpers/margin-types'
import { getOrCreateTransaction } from './amm-core'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'

export function handleVestingPositionCreated(event: VestingPositionCreatedEvent): void {
  let transaction = getOrCreateTransaction(event)
  createUserIfNecessary(event.params.vestingPosition.creator)

  let index = InterestIndex.load(ARB_ADDRESS) as InterestIndex
  let position = new LiquidityMiningVestingPosition(event.params.vestingPosition.id.toString())
  position.status = LiquidityMiningVestingPositionStatus.ACTIVE
  position.creator = event.params.vestingPosition.creator.toHexString()
  position.owner = event.params.vestingPosition.creator.toHexString()
  position.openTransaction = transaction.id
  position.startTimestamp = event.params.vestingPosition.startTime
  position.duration = event.params.vestingPosition.duration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.oARBAmount = convertTokenToDecimal(event.params.vestingPosition.amount, _18_BI)
  position.arbAmountPar = weiToPar(position.oARBAmount, index, _18_BI)
  position.ethSpent = ZERO_BD
  position.arbTaxesPaid = ZERO_BD
  position.save()

  let arbToken = Token.load(ARB_ADDRESS) as Token
  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, arbToken)
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(position.arbAmountPar)
  effectiveUserTokenValue.save()
}

export function handleVestingPositionDurationExtended(event: VestingPositionDurationExtendedEvent): void {
  let positionId = event.params.vestingId.toString()
  let position = LiquidityMiningVestingPosition.load(positionId) as LiquidityMiningVestingPosition
  position.duration = event.params.newDuration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.save()
}

export function handleVestingPositionTransfer(event: LiquidityMiningVestingPositionTransferEvent): void {
  if (event.params.to.toHexString() != ADDRESS_ZERO) {
    createUserIfNecessary(event.params.to)
  }

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Core)
  let transfer = new LiquidityMiningVestingPositionTransfer(dolomiteMargin.vestingPositionTransferCount.toString())
  transfer.transaction = transaction.id
  transfer.logIndex = event.logIndex
  transfer.serialId = dolomiteMargin.vestingPositionTransferCount

  if (event.params.from.toHexString() != ADDRESS_ZERO) {
    transfer.fromEffectiveUser = getEffectiveUserForAddress(event.params.from).id
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO) {
    transfer.toEffectiveUser = getEffectiveUserForAddress(event.params.to).id
  }

  transfer.vestingPosition = event.params.tokenId.toString()
  transfer.save()

  if (transfer.fromEffectiveUser !== null && transfer.toEffectiveUser !== null) {
    let position = LiquidityMiningVestingPosition.load(
      event.params.tokenId.toString(),
    ) as LiquidityMiningVestingPosition
    position.owner = event.params.to.toHexString()
    position.save()

    let arbToken = Token.load(ARB_ADDRESS) as Token

    let fromEffectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(transfer.fromEffectiveUser as string, arbToken)
    fromEffectiveUserTokenValue.totalSupplyPar = fromEffectiveUserTokenValue.totalSupplyPar.minus(position.arbAmountPar)
    fromEffectiveUserTokenValue.save()

    let toEffectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(transfer.toEffectiveUser as string, arbToken)
    toEffectiveUserTokenValue.totalSupplyPar = toEffectiveUserTokenValue.totalSupplyPar.plus(position.arbAmountPar)
    toEffectiveUserTokenValue.save()
  }

  dolomiteMargin.vestingPositionTransferCount = dolomiteMargin.vestingPositionTransferCount.plus(ONE_BI)
  dolomiteMargin.save()
}

export function handleVestingPositionClosed(event: VestingPositionClosedEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp
  position.ethSpent = convertTokenToDecimal(event.params.ethCostPaid, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionEmergencyWithdraw(event: VestingPositionEmergencyWithdrawEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTimestamp = event.block.timestamp
  position.closeTransaction = transaction.id
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.EMERGENCY_CLOSED
  position.save()

  handleVestingPositionClose(position)
}

const seasonNumber = 0

export function handleOArbClaimed(event: OARBClaimedEvent): void {
  let claim = new LiquidityMiningClaim(`${event.params.user.toHexString()}-${event.params.epoch.toString()}`)
  claim.user = event.params.user.toHexString()
  claim.epoch = event.params.epoch.toI32()
  claim.seasonNumber = seasonNumber
  claim.amount = convertTokenToDecimal(event.params.amount, _18_BI)
  claim.save()

  let season = LiquidityMiningSeason.load(getLiquidityMiningSeasonId(event.params.user, seasonNumber))
  if (season === null) {
    season = new LiquidityMiningSeason(getLiquidityMiningSeasonId(event.params.user, seasonNumber))
    season.user = claim.user
    season.seasonNumber = seasonNumber
    season.totalClaimAmount = ZERO_BD
  }
  season.totalClaimAmount = season.totalClaimAmount.plus(claim.amount)
  season.save()
}

export function handleLevelRequestInitiated(event: LevelRequestInitiatedEvent): void {
  let transaction = getOrCreateTransaction(event)
  createUserIfNecessary(event.params.user)

  let request = new LiquidityMiningLevelUpdateRequest(event.params.requestId.toString())
  request.user = event.params.user.toHexString()
  request.requestId = event.params.requestId
  request.initiateTransaction = transaction.id
  request.isFulfilled = false
  request.save()
}

export function handleLevelRequestFinalized(event: LevelRequestFinalizedEvent): void {
  let transaction = getOrCreateTransaction(event)

  let request = LiquidityMiningLevelUpdateRequest.load(
    event.params.requestId.toString()
  ) as LiquidityMiningLevelUpdateRequest
  request.fulfilmentTransaction = transaction.id
  request.isFulfilled = true
  request.level = event.params.level.toI32()
  request.save()
}
