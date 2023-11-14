import {
  EmergencyWithdraw as VestingPositionEmergencyWithdrawEvent,
  PositionClosed as VestingPositionClosedEvent,
  PositionForceClosed as VestingPositionForceClosedEvent,
  Transfer as VestingPositionTransferEvent,
  VestingPositionCreated as VestingPositionCreatedEvent,
} from '../types/LiquidityMiningVester/LiquidityMiningVester'
import { Claimed as OARBClaimedEvent } from '../types/LiquidityMiningClaimer/LiquidityMiningClaimer'
import {
  InterestIndex,
  LiquidityMiningClaim,
  LiquidityMiningSeason,
  LiquidityMiningVestingPosition,
  VestingPositionTransfer,
} from '../types/schema'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { _18_BI, ADDRESS_ZERO, ONE_BI, ZERO_BD } from './generated/constants'
import { getLiquidityMiningSeasonId, LiquidityMiningVestingPositionStatus } from './helpers/liquidity-mining-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'
import { getOrCreateDolomiteMarginForCall, weiToPar } from './helpers/margin-helpers'
import { ProtocolType } from './helpers/margin-types'
import { getOrCreateTransaction } from './amm-core'
import { ARB_ADDRESS } from '../mappings/generated/constants'

export function handleVestingPositionCreated(event: VestingPositionCreatedEvent): void {
  createUserIfNecessary(event.params.vestingPosition.creator)

  let index = InterestIndex.load(ARB_ADDRESS) as InterestIndex
  let position = new LiquidityMiningVestingPosition(event.params.vestingPosition.id.toString())
  position.status = LiquidityMiningVestingPositionStatus.ACTIVE
  position.creator = event.params.vestingPosition.creator.toHexString()
  position.owner = event.params.vestingPosition.creator.toHexString()
  position.duration = event.params.vestingPosition.duration
  position.startTimestamp = event.params.vestingPosition.startTime
  position.oARBAmount = convertTokenToDecimal(event.params.vestingPosition.amount, _18_BI)
  position.arbAmountPar = weiToPar(position.oARBAmount, index, _18_BI);
  position.ethSpent = ZERO_BD
  position.arbTaxesPaid = ZERO_BD
  position.save()
}

export function handleVestingPositionTransfer(event: VestingPositionTransferEvent): void {
  if (event.params.from.toHexString() != ADDRESS_ZERO && event.params.to.toHexString() != ADDRESS_ZERO) {
    createUserIfNecessary(event.params.to)
    let position = LiquidityMiningVestingPosition.load(
      event.params.tokenId.toString(),
    ) as LiquidityMiningVestingPosition
    position.owner = event.params.to.toHexString()
    position.save()

    let transaction = getOrCreateTransaction(event)

    let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Core)
    let transfer = new VestingPositionTransfer(dolomiteMargin.vestingPositionTransferCount.toString())
    transfer.transaction = transaction.id
    transfer.logIndex = event.logIndex
    transfer.serialId = dolomiteMargin.vestingPositionTransferCount
    transfer.fromUser = event.params.from.toHexString()
    transfer.toUser = event.params.to.toHexString()
    transfer.vestingPosition = position.id
    transfer.save()

    dolomiteMargin.vestingPositionTransferCount = dolomiteMargin.vestingPositionTransferCount.plus(ONE_BI)
    dolomiteMargin.save()
  }
}

export function handleVestingPositionClosed(event: VestingPositionClosedEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTimestamp = event.block.timestamp
  position.ethSpent = convertTokenToDecimal(event.params.ethCostPaid, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTimestamp = event.block.timestamp
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED
  position.save()
}

export function handleVestingPositionEmergencyWithdraw(event: VestingPositionEmergencyWithdrawEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.closeTimestamp = event.block.timestamp
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.EMERGENCY_CLOSED
  position.save()
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
