import {
  Address,
  BigInt,
  ethereum,
  log
} from '@graphprotocol/graph-ts'
import { Claimed as OARBClaimedEvent } from '../types/LiquidityMiningClaimer/LiquidityMiningClaimer'
import {
  EmergencyWithdraw as VestingPositionEmergencyWithdrawEvent,
  LevelRequestFinalized as LevelRequestFinalizedEvent,
  LevelRequestInitiated as LevelRequestInitiatedEvent,
  LiquidityMiningVester as LiquidityMiningVesterProtocol,
  PositionClosed as VestingPositionClosedEvent,
  PositionDurationExtended as VestingPositionDurationExtendedEvent,
  PositionForceClosed as VestingPositionForceClosedEvent,
  Transfer as LiquidityMiningVestingPositionTransferEvent,
  VestingPositionCreatedNew as VestingPositionCreatedEventNew,
  VestingPositionCreatedOld as VestingPositionCreatedEventOld
} from '../types/LiquidityMiningVester/LiquidityMiningVester'
import {
  InterestIndex,
  LiquidityMiningLevelUpdateRequest,
  LiquidityMiningVester,
  LiquidityMiningVestingPosition,
  LiquidityMiningVestingPositionTransfer,
  Token
} from '../types/schema'
import { getOrCreateTransaction } from './amm-core'
import {
  _18_BI,
  ADDRESS_ZERO,
  ARB_ADDRESS,
  GOARB_VESTER_PROXY_ADDRESS,
  OARB_VESTER_PROXY_ADDRESS,
  ONE_BI,
  WETH_ADDRESS,
  ZERO_BD,
  ZERO_BI
} from './generated/constants'
import { getOrCreateInterestIndexSnapshotAndReturnId } from './helpers/helpers'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import {
  getVestingPosition,
  getVestingPositionId,
  handleClaim,
  handleVestingPositionClose,
  LiquidityMiningVestingPositionStatus
} from './helpers/liquidity-mining-helpers'
import {
  getOrCreateDolomiteMarginForCall,
  getOrCreateEffectiveUserTokenValue,
  weiToPar
} from './helpers/margin-helpers'
import { ProtocolType } from './helpers/margin-types'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'

let OARB_TOKEN_ADDRESS = Address.fromHexString('0xCBED801b4162bf2A19B06968663438b5165A6A93')

function getOrCreateLiquidityMiningVester(event: ethereum.Event): LiquidityMiningVester {
  let vester = LiquidityMiningVester.load(event.address.toHexString())
  if (vester === null) {
    vester = new LiquidityMiningVester(event.address.toHexString())
    let protocol = LiquidityMiningVesterProtocol.bind(event.address)

    if (event.address.equals(Address.fromHexString(OARB_VESTER_PROXY_ADDRESS))) {
      vester.oTokenAddress = OARB_TOKEN_ADDRESS
    } else {
      vester.oTokenAddress = protocol.oToken()
    }

    if (event.address.equals(Address.fromHexString(OARB_VESTER_PROXY_ADDRESS))) {
      vester.pairToken = ARB_ADDRESS
    } else {
      vester.pairToken = protocol.PAIR_TOKEN().toHexString()
    }

    if (event.address.equals(Address.fromHexString(OARB_VESTER_PROXY_ADDRESS))) {
      vester.paymentToken = WETH_ADDRESS
    } else {
      vester.paymentToken = protocol.PAYMENT_TOKEN().toHexString()
    }

    vester.save()
  }
  return vester
}

function requireValidVester(event: ethereum.Event): boolean {
  let vester: LiquidityMiningVester | null
  if (event.address.equals(Address.fromHexString(GOARB_VESTER_PROXY_ADDRESS))) {
    vester = getOrCreateLiquidityMiningVester(event)
  } else if (event.address.equals(Address.fromHexString(OARB_VESTER_PROXY_ADDRESS))) {
    vester = getOrCreateLiquidityMiningVester(event)
  } else {
    vester = LiquidityMiningVester.load(event.address.toHexString())
  }

  if (vester === null) {
    log.info('Invalid vester, found {}', [event.address.toHexString()])
  }
  return vester !== null
}

function handleVestingPositionCreated(
  event: ethereum.Event,
  positionId: BigInt,
  creator: Address,
  startTime: BigInt,
  duration: BigInt,
  oTokenAmount: BigInt,
  pairAmount: BigInt
): void {
  if (!requireValidVester(event)) {
    return
  }

  let transaction = getOrCreateTransaction(event)
  createUserIfNecessary(creator)

  let vester = LiquidityMiningVester.load(event.address.toHexString()) as LiquidityMiningVester

  let position = new LiquidityMiningVestingPosition(getVestingPositionId(event, positionId))
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
    event.params.vestingPosition.amount
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
    event.params.vestingPosition.pairAmount
  )
}

export function handleVestingPositionDurationExtended(event: VestingPositionDurationExtendedEvent): void {
  if (!requireValidVester(event)) {
    return
  }

  let position = getVestingPosition(event, event.params.vestingId)
  position.duration = event.params.newDuration
  position.endTimestamp = position.startTimestamp.plus(position.duration)
  position.save()
}

export function handleVestingPositionTransfer(event: LiquidityMiningVestingPositionTransferEvent): void {
  if (!requireValidVester(event)) {
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

  let vestingPosition = getVestingPosition(event, event.params.tokenId)
  let marketInterestIndex = InterestIndex.load(vester.pairToken)
  if (marketInterestIndex !== null) {
    transfer.pairInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketInterestIndex)
  }

  transfer.vestingPosition = vestingPosition.id
  transfer.save()

  if (transfer.fromEffectiveUser !== null && transfer.toEffectiveUser !== null) {
    let position = getVestingPosition(event, event.params.tokenId)
    position.owner = event.params.to.toHexString()
    position.save()

    let fromEffectiveUserTokenValue = getOrCreateEffectiveUserTokenValue(
      transfer.fromEffectiveUser as string,
      pairToken
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
  if (!requireValidVester(event)) {
    return
  }

  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
  position.closeTransaction = transaction.id
  position.closeTimestamp = event.block.timestamp

  let vester = LiquidityMiningVester.load(position.vester) as LiquidityMiningVester
  let paymentToken = Token.load(vester.paymentToken) as Token
  position.paymentAmountWei = convertTokenToDecimal(event.params.ethCostPaid, paymentToken.decimals)

  position.status = LiquidityMiningVestingPositionStatus.CLOSED
  position.save()

  handleVestingPositionClose(position)
}

export function handleVestingPositionForceClosed(event: VestingPositionForceClosedEvent): void {
  if (!requireValidVester(event)) {
    return
  }

  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
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
  if (!requireValidVester(event)) {
    return
  }

  let transaction = getOrCreateTransaction(event)

  let position = getVestingPosition(event, event.params.vestingId)
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
  if (!requireValidVester(event)) {
    return
  }

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
  if (!requireValidVester(event)) {
    return
  }

  let transaction = getOrCreateTransaction(event)

  let request = LiquidityMiningLevelUpdateRequest.load(
    event.params.requestId.toString()
  ) as LiquidityMiningLevelUpdateRequest
  request.fulfilmentTransaction = transaction.id
  request.isFulfilled = true
  request.level = event.params.level.toI32()
  request.save()
}
