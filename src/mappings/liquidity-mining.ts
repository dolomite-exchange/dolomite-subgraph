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
  LiquidityMiningLevelUpdateRequest,
  LiquidityMiningVestingPosition,
  LiquidityMiningVestingPositionTransfer,
  Token,
} from '../types/schema'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { _18_BI, ADDRESS_ZERO, ARB_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from './generated/constants'
import {
  getVestingPosition,
  getVestingPositionId,
  handleClaim,
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
import { getOrCreateInterestIndexSnapshotAndReturnId } from './helpers/helpers'

export function handleVestingPositionCreated(event: VestingPositionCreatedEvent): void {
  let transaction = getOrCreateTransaction(event)
  createUserIfNecessary(event.params.vestingPosition.creator)

  // TODO: fix for other types of oTokens
  let pairToken = Token.load(ARB_ADDRESS) as Token
  let index = InterestIndex.load(pairToken.id) as InterestIndex
  let position = new LiquidityMiningVestingPosition(getVestingPositionId(event, event.params.vestingPosition.id))
  position.status = LiquidityMiningVestingPositionStatus.ACTIVE
  position.creator = event.params.vestingPosition.creator.toHexString()
  position.owner = event.params.vestingPosition.creator.toHexString()
  position.openTransaction = transaction.id
  position.startTimestamp = event.params.vestingPosition.startTime
  position.duration = event.params.vestingPosition.duration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.oTokenAmount = convertTokenToDecimal(event.params.vestingPosition.amount, _18_BI)
  position.pairToken = pairToken.id
  position.pairAmountPar = weiToPar(position.oTokenAmount, index, _18_BI)
  position.tokenSpent = ZERO_BD
  position.pairTaxesPaid = ZERO_BD
  position.save()

  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, pairToken)
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(position.pairAmountPar)
  effectiveUserTokenValue.save()
}

export function handleVestingPositionDurationExtended(event: VestingPositionDurationExtendedEvent): void {
  let position = getVestingPosition(event, event.params.vestingId)
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

  let vestingPosition = getVestingPosition(event, event.params.tokenId)
  let marketInterestIndex = InterestIndex.load(vestingPosition.pairToken) as InterestIndex
  transfer.pairInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketInterestIndex)

  transfer.vestingPosition = vestingPosition.id
  transfer.save()

  if (transfer.fromEffectiveUser !== null && transfer.toEffectiveUser !== null) {
    let position = getVestingPosition(event, event.params.tokenId)
    position.owner = event.params.to.toHexString()
    position.save()

    let pairToken = Token.load(vestingPosition.pairToken) as Token

    let fromEffectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(
      transfer.fromEffectiveUser as string,
      pairToken,
    )
    fromEffectiveUserTokenValue.totalSupplyPar = fromEffectiveUserTokenValue.totalSupplyPar
      .minus(position.pairAmountPar)
    fromEffectiveUserTokenValue.save()

    let toEffectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(transfer.toEffectiveUser as string, pairToken)
    toEffectiveUserTokenValue.totalSupplyPar = toEffectiveUserTokenValue.totalSupplyPar.plus(position.pairAmountPar)
    toEffectiveUserTokenValue.save()
  }

  dolomiteMargin.vestingPositionTransferCount = dolomiteMargin.vestingPositionTransferCount.plus(ONE_BI)
  dolomiteMargin.save()
}

export function handleVestingPositionClosed(event: VestingPositionClosedEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp
  position.tokenSpent = convertTokenToDecimal(event.params.ethCostPaid, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp
  position.pairTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionEmergencyWithdraw(event: VestingPositionEmergencyWithdrawEvent): void {
  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
  position.closeTimestamp = event.block.timestamp
  position.closeTransaction = transaction.id
  position.pairTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.EMERGENCY_CLOSED
  position.save()

  handleVestingPositionClose(position)
}

const seasonNumber = ZERO_BI

export function handleOArbClaimed(event: OARBClaimedEvent): void {
  handleClaim(event.address, event.params.user, event.params.epoch, seasonNumber, event.params.amount)
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
    event.params.requestId.toString(),
  ) as LiquidityMiningLevelUpdateRequest
  request.fulfilmentTransaction = transaction.id
  request.isFulfilled = true
  request.level = event.params.level.toI32()
  request.save()
}
