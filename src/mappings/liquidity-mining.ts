import { Address, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import { Claimed as OARBClaimedEvent } from '../types/LiquidityMiningClaimer/LiquidityMiningClaimer'
import {
  EmergencyWithdraw as VestingPositionEmergencyWithdrawEvent,
  LevelRequestFinalized as LevelRequestFinalizedEvent,
  LevelRequestInitiated as LevelRequestInitiatedEvent,
  PositionClosed as VestingPositionClosedEvent,
  PositionDurationExtended as VestingPositionDurationExtendedEvent,
  PositionForceClosed as VestingPositionForceClosedEvent,
  Transfer as LiquidityMiningVestingPositionTransferEvent,
  VestingPositionCreated as VestingPositionCreatedEventOld,
  VestingPositionCreated1 as VestingPositionCreatedEventNew,
  VestingStarted as VestingPositionStartedEventOld,
  VestingStarted1 as VestingPositionStartedEventNew,
} from '../types/templates/LiquidityMiningVester/LiquidityMiningVester'
import {
  InterestIndex,
  LiquidityMiningLevelUpdateRequest,
  LiquidityMiningVester,
  LiquidityMiningVestingPosition,
  LiquidityMiningVestingPositionTransfer,
  Token,
} from '../types/schema'
import { getOrCreateTransaction } from './amm-core'
import { _18_BI, ADDRESS_ZERO, ONE_BI, ZERO_BD, ZERO_BI } from './generated/constants'
import { getOrCreateInterestIndexSnapshotAndReturnId } from './helpers/helpers'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import {
  getVestingPosition,
  getVestingPositionId,
  handleClaim,
  handleVestingPositionClose,
  LiquidityMiningVestingPositionStatus,
} from './helpers/liquidity-mining-helpers'
import {
  getOrCreateDolomiteMarginForCall,
  getOrCreateEffectiveUserTokenValue,
  weiToPar,
} from './helpers/margin-helpers'
import { ProtocolType } from './helpers/margin-types'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'

function handleVestingPositionCreated(
  event: ethereum.Event,
  positionId: BigInt,
  creator: Address,
  startTime: BigInt,
  duration: BigInt,
  oTokenAmount: BigInt,
  pairAmount: BigInt,
): void {
  let transaction = getOrCreateTransaction(event)
  createUserIfNecessary(creator)

  let vester = LiquidityMiningVester.load(event.address.toHexString()) as LiquidityMiningVester

  let position = LiquidityMiningVestingPosition.load(getVestingPositionId(event, positionId))
  if (position !== null) {
    // Position was already created (which can happen between the duplicate calls to VestingStarted and
    // VestingPositionCreated
    return
  }

  position = new LiquidityMiningVestingPosition(getVestingPositionId(event, positionId))
  position.vester = vester.id
  position.positionId = positionId
  position.status = LiquidityMiningVestingPositionStatus.ACTIVE
  position.creator = creator.toHexString()
  position.owner = creator.toHexString()
  position.openTransaction = transaction.id
  position.startTimestamp = startTime
  position.duration = duration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.oTokenAmount = convertTokenToDecimal(oTokenAmount, _18_BI)

  let pairToken = Token.load(vester.pairToken) as Token
  let index = InterestIndex.load(vester.pairToken)
  if (index === null) {
    position.pairAmountPar = convertTokenToDecimal(pairAmount, pairToken.decimals)
  } else {
    position.pairAmountPar = weiToPar(convertTokenToDecimal(pairAmount, pairToken.decimals), index, pairToken.decimals)
  }

  position.paymentAmountWei = ZERO_BD
  position.pairTaxesPaid = ZERO_BD
  position.save()

  let effectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(position.owner, pairToken)
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(position.pairAmountPar)
  effectiveUserTokenValue.save()
}

export function handleVestingPositionCreatedOld(event: VestingPositionCreatedEventOld): void {
  handleVestingPositionCreated(
    event,
    event.params.vestingPosition.id,
    event.params.vestingPosition.creator,
    event.params.vestingPosition.startTime,
    event.params.vestingPosition.duration,
    event.params.vestingPosition.amount,
    event.params.vestingPosition.amount,
  )
}

export function handleVestingPositionCreatedNew(event: VestingPositionCreatedEventNew): void {
  handleVestingPositionCreated(
    event,
    event.params.vestingPosition.id,
    event.params.vestingPosition.creator,
    event.params.vestingPosition.startTime,
    event.params.vestingPosition.duration,
    event.params.vestingPosition.oTokenAmount,
    event.params.vestingPosition.pairAmount,
  )
}

export function handleVestingPositionStartedOld(event: VestingPositionStartedEventOld): void {
  handleVestingPositionCreated(
    event,
    event.params.vestingId,
    event.params.owner,
    event.block.timestamp,
    event.params.duration,
    event.params.amount,
    event.params.amount,
  )
}

export function handleVestingPositionStartedNew(event: VestingPositionStartedEventNew): void {
  handleVestingPositionCreated(
    event,
    event.params.vestingId,
    event.params.owner,
    event.block.timestamp,
    event.params.duration,
    event.params.oTokenAmount,
    event.params.pairAmount,
  )
}

export function handleVestingPositionDurationExtended(event: VestingPositionDurationExtendedEvent): void {
  let position = getVestingPosition(event, event.params.vestingId)
  if (position === null) {
    log.warning('Vesting position is unexpectedly null: {}', [getVestingPositionId(event, event.params.vestingId)])
    return
  }

  position.duration = event.params.newDuration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.save()
}

export function handleVestingPositionTransfer(event: LiquidityMiningVestingPositionTransferEvent): void {
  let position = getVestingPosition(event, event.params.tokenId)
  if (position === null) {
    log.warning('Vesting position is unexpectedly null: {}', [getVestingPositionId(event, event.params.tokenId)])
    return
  }

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

  let vester = LiquidityMiningVester.load(event.address.toHexString()) as LiquidityMiningVester
  let pairToken = Token.load(vester.pairToken) as Token

  let marketInterestIndex = InterestIndex.load(vester.pairToken)
  if (marketInterestIndex !== null) {
    transfer.pairInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketInterestIndex)
  }

  transfer.vestingPosition = position.id
  transfer.save()

  if (transfer.fromEffectiveUser !== null && transfer.toEffectiveUser !== null) {
    position.owner = event.params.to.toHexString()
    position.save()

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
  let position = getVestingPosition(event, event.params.vestingId)
  if (position === null) {
    log.warning('Vesting position is unexpectedly null: {}', [getVestingPositionId(event, event.params.vestingId)])
    return
  }

  let transaction = getOrCreateTransaction(event)

  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp

  let vester = LiquidityMiningVester.load(position.vester) as LiquidityMiningVester
  let paymentToken = Token.load(vester.paymentToken) as Token
  position.paymentAmountWei = convertTokenToDecimal(event.params.amountPaidWei, paymentToken.decimals)

  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  let position = getVestingPosition(event, event.params.vestingId)
  if (position === null) {
    log.warning('Vesting position is unexpectedly null: {}', [getVestingPositionId(event, event.params.vestingId)])
    return
  }

  let transaction = getOrCreateTransaction(event)

  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp

  let vester = LiquidityMiningVester.load(position.vester) as LiquidityMiningVester
  let pairToken = Token.load(vester.pairToken) as Token
  position.pairTaxesPaid = convertTokenToDecimal(event.params.pairTax, pairToken.decimals)

  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionEmergencyWithdraw(event: VestingPositionEmergencyWithdrawEvent): void {
  let position = getVestingPosition(event, event.params.vestingId)
  if (position === null) {
    log.warning('Vesting position is unexpectedly null: {}', [getVestingPositionId(event, event.params.vestingId)])
    return
  }

  let transaction = getOrCreateTransaction(event)

  position.closeTimestamp = event.block.timestamp
  position.closeTransaction = transaction.id
  position.pairTaxesPaid = convertTokenToDecimal(event.params.pairTax, _18_BI)
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
