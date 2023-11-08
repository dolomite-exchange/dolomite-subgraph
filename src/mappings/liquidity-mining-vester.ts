import {
  EmergencyWithdraw as VestingPositionEmergencyWithdrawEvent,
  PositionClosed as VestingPositionClosedEvent,
  PositionForceClosed as VestingPositionForceClosedEvent,
  Transfer as VestingPositionTransferEvent,
  VestingPositionCreated as VestingPositionCreatedEvent,
} from '../types/LiquidityMiningVester/LiquidityMiningVester'
import { LiquidityMiningVestingPosition } from '../types/schema'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { _18_BI, ADDRESS_ZERO, ZERO_BD } from './generated/constants'
import { LiquidityMiningVestingPositionStatus } from './helpers/liquidity-mining-vesting-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'

export function handleVestingPositionCreated(event: VestingPositionCreatedEvent): void {
  createUserIfNecessary(event.params.vestingPosition.creator)

  let position = new LiquidityMiningVestingPosition(event.params.vestingPosition.id.toString())
  position.status = LiquidityMiningVestingPositionStatus.ACTIVE
  position.creator = event.params.vestingPosition.creator.toHexString()
  position.owner = event.params.vestingPosition.creator.toHexString()
  position.duration = event.params.vestingPosition.duration
  position.startTimestamp = event.params.vestingPosition.startTime
  position.oARBAmount = convertTokenToDecimal(event.params.vestingPosition.amount, _18_BI)
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
  }
}

export function handleVestingPositionClosed(event: VestingPositionClosedEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.ethSpent = convertTokenToDecimal(event.params.ethCostPaid, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED
  position.save()
}

export function handleVestingPositionEmergencyWithdraw(event: VestingPositionEmergencyWithdrawEvent): void {
  let position = LiquidityMiningVestingPosition.load(
    event.params.vestingId.toString(),
  ) as LiquidityMiningVestingPosition
  position.arbTaxesPaid = convertTokenToDecimal(event.params.arbTax, _18_BI)
  position.status = LiquidityMiningVestingPositionStatus.EMERGENCY_CLOSED
  position.save()
}
