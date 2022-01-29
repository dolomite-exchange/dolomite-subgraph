import {
  Address,
  BigDecimal,
  BigInt,
  ethereum,
  log
} from '@graphprotocol/graph-ts/index'
import { DolomiteMargin as DolomiteMarginAdminProtocol } from '../types/MarginAdmin/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryAdminProtocol } from '../types/MarginAdmin/DolomiteMarginExpiry'
import { DolomiteMargin as DolomiteMarginCoreProtocol } from '../types/MarginCore/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryCoreProtocol } from '../types/MarginCore/DolomiteMarginExpiry'
import { DolomiteMargin as DolomiteMarginExpiryProtocol } from '../types/MarginExpiry/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryExpiryProtocol } from '../types/MarginExpiry/DolomiteMarginExpiry'
import {
  DolomiteMargin,
  InterestIndex,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  MarketRiskInfo,
  Token
} from '../types/schema'
import {
  convertStructToDecimal,
  convertTokenToDecimal,
  createUserIfNecessary
} from './amm-helpers'
import { getTokenOraclePriceUSD } from './amm-pricing'
import {
  BD_ONE_ETH,
  DOLOMITE_MARGIN_ADDRESS,
  EXPIRY_ADDRESS,
  ONE_BD,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
} from './generated/constants'
import { absBD } from './helpers'
import {
  MarginPositionStatus,
  ProtocolType,
  ValueStruct
} from './margin-types'

export function getOrCreateTokenValue(
  marginAccount: MarginAccount,
  token: Token
): MarginAccountTokenValue {
  let id = marginAccount.user + '-' + marginAccount.accountNumber.toString() + '-' + token.marketId.toString()
  let tokenValue = MarginAccountTokenValue.load(id)
  if (tokenValue === null) {
    tokenValue = new MarginAccountTokenValue(id)
    tokenValue.marginAccount = marginAccount.id
    tokenValue.token = token.id
    tokenValue.valuePar = ZERO_BD
  }

  return tokenValue as MarginAccountTokenValue
}

export function getOrCreateMarginAccount(owner: Address, accountNumber: BigInt, block: ethereum.Block): MarginAccount {
  let id = owner.toHexString() + '-' + accountNumber.toString()
  let marginAccount = MarginAccount.load(id)
  if (marginAccount === null) {
    createUserIfNecessary(owner)

    marginAccount = new MarginAccount(id)
    marginAccount.user = owner.toHexString()
    marginAccount.accountNumber = accountNumber
    marginAccount.borrowedMarketIds = []
    marginAccount.expirationMarketIds = []
    marginAccount.hasBorrowedValue = false
    marginAccount.hasExpiration = false
  }

  marginAccount.lastUpdatedBlockNumber = block.number
  marginAccount.lastUpdatedTimestamp = block.timestamp

  return marginAccount as MarginAccount
}

export function getOrCreateMarginPosition(event: ethereum.Event, account: MarginAccount): MarginPosition {
  let marginPosition = MarginPosition.load(account.id)
  if (marginPosition === null) {
    marginPosition = new MarginPosition(account.id)
    marginPosition.marginAccount = account.id
    marginPosition.status = MarginPositionStatus.Open

    marginPosition.openTimestamp = event.block.timestamp
    marginPosition.openTransaction = event.transaction.hash.toHexString()

    marginPosition.marginDeposit = ZERO_BD
    marginPosition.marginDepositUSD = ZERO_BD

    marginPosition.initialHeldAmountPar = ZERO_BD
    marginPosition.initialHeldAmountWei = ZERO_BD
    marginPosition.initialHeldAmountUSD = ZERO_BD
    marginPosition.initialHeldPriceUSD = ZERO_BD
    marginPosition.heldAmountPar = ZERO_BD

    marginPosition.initialOwedAmountPar = ZERO_BD
    marginPosition.initialOwedAmountWei = ZERO_BD
    marginPosition.initialOwedAmountUSD = ZERO_BD
    marginPosition.initialOwedPriceUSD = ZERO_BD
    marginPosition.owedAmountPar = ZERO_BD
  }

  return marginPosition as MarginPosition
}

export function getOrCreateDolomiteMarginForCall(
  event: ethereum.Event,
  isAction: boolean,
  protocolType: string
): DolomiteMargin {
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS)
  if (dolomiteMargin === null) {
    dolomiteMargin = new DolomiteMargin(DOLOMITE_MARGIN_ADDRESS)

    dolomiteMargin.supplyLiquidityUSD = ZERO_BD
    dolomiteMargin.borrowLiquidityUSD = ZERO_BD

    dolomiteMargin.numberOfMarkets = 0

    if (protocolType === ProtocolType.Core) {
      let marginProtocol = DolomiteMarginCoreProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryCoreProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH)
        .div(BD_ONE_ETH)
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else if (protocolType == ProtocolType.Admin) {
      let marginProtocol = DolomiteMarginAdminProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryAdminProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH)
        .div(BD_ONE_ETH)
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else {
      let marginProtocol = DolomiteMarginExpiryProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryExpiryProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH)
        .div(BD_ONE_ETH)
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    }

    dolomiteMargin.totalBorrowVolumeUSD = ZERO_BD
    dolomiteMargin.totalLiquidationVolumeUSD = ZERO_BD
    dolomiteMargin.totalSupplyVolumeUSD = ZERO_BD
    dolomiteMargin.totalTradeVolumeUSD = ZERO_BD
    dolomiteMargin.totalVaporizationVolumeUSD = ZERO_BD

    dolomiteMargin.lastTransactionHash = ZERO_BYTES

    dolomiteMargin.actionCount = ZERO_BI
    dolomiteMargin.liquidationCount = ZERO_BI
    dolomiteMargin.tradeCount = ZERO_BI
    dolomiteMargin.transactionCount = ZERO_BI
    dolomiteMargin.vaporizationCount = ZERO_BI
  }

  if (dolomiteMargin.lastTransactionHash.notEqual(event.transaction.hash)) {
    dolomiteMargin.lastTransactionHash = event.transaction.hash
    dolomiteMargin.transactionCount = dolomiteMargin.transactionCount.plus(ONE_BI)
  }

  if (isAction) {
    dolomiteMargin.actionCount = dolomiteMargin.actionCount.plus(ONE_BI)
    dolomiteMargin.save()
  }

  return dolomiteMargin as DolomiteMargin
}

export function roundHalfUp(bd: BigDecimal, decimals: BigInt): BigDecimal {
  // Add 0.5 to the number being truncated off. This allows us to effectively round up
  let amountToAdd = BigDecimal.fromString('5')
    .div(new BigDecimal(BigInt.fromString('10')
      .pow(decimals.plus(ONE_BI)
        .toI32() as u8)))

  if (bd.lt(ZERO_BD)) {
    return bd.minus(amountToAdd)
      .truncate(decimals.toI32())
  } else {
    return bd.plus(amountToAdd)
      .truncate(decimals.toI32())
  }
}

// noinspection JSUnusedGlobalSymbols
export function weiToPar(wei: BigDecimal, index: InterestIndex, decimals: BigInt): BigDecimal {
  if (wei.ge(ZERO_BD)) {
    return roundHalfUp(wei.div(index.supplyIndex), decimals)
  } else {
    return roundHalfUp(wei.div(index.borrowIndex), decimals)
  }
}

export function parToWei(par: BigDecimal, index: InterestIndex, decimals: BigInt): BigDecimal {
  if (par.ge(ZERO_BD)) {
    return roundHalfUp(par.times(index.supplyIndex), decimals)
  } else {
    return roundHalfUp(par.times(index.borrowIndex), decimals)
  }
}

function isRepaymentOfBorrowAmount(
  newPar: BigDecimal,
  deltaWei: BigDecimal,
  index: InterestIndex,
  decimals: BigInt
): boolean {
  let newWei = parToWei(newPar, index, decimals)
  let oldWei = newWei.minus(deltaWei)
  return deltaWei.gt(ZERO_BD) && oldWei.lt(ZERO_BD) // the user added to the negative balance (decreasing it)
}

function getMarketTotalBorrowWei(
  borrowPar: BigInt,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals
  return parToWei(convertTokenToDecimal(borrowPar.neg(), token.decimals), index, token.decimals)
    .neg()
    .truncate(decimals.toI32())
}

function getMarketTotalSupplyWei(
  supplyPar: BigInt,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals
  return parToWei(convertTokenToDecimal(supplyPar, token.decimals), index, decimals)
    .truncate(decimals.toI32())
}

export function changeProtocolBalance(
  event: ethereum.Event,
  token: Token,
  newParStruct: ValueStruct,
  deltaWeiStruct: ValueStruct,
  index: InterestIndex,
  isVirtualTransfer: boolean,
  protocolType: string,
  dolomiteMargin: DolomiteMargin
): void {
  let tokenPriceUSD = getTokenOraclePriceUSD(token, event, protocolType)

  let newPar = convertStructToDecimal(newParStruct, token.decimals)
  let newWei = parToWei(newPar, index, token.decimals)
  let deltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)

  let totalSupplyPar: BigInt
  let totalBorrowPar: BigInt
  if (protocolType == ProtocolType.Core) {
    let protocol = DolomiteMarginCoreProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
    let totalPar = protocol.getMarketTotalPar(token.marketId)
    totalSupplyPar = totalPar.supply
    totalBorrowPar = totalPar.borrow
  } else if (protocolType == ProtocolType.Admin) {
    let protocol = DolomiteMarginAdminProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
    let totalPar = protocol.getMarketTotalPar(token.marketId)
    totalSupplyPar = totalPar.supply
    totalBorrowPar = totalPar.borrow
  } else {
    log.error('Could not find protocol type: {}', [protocolType])
    return
  }

  if (newPar.lt(ZERO_BD) && deltaWei.lt(ZERO_BD)) {
    // the user borrowed funds

    let borrowVolumeToken = absBD(deltaWei)
    if (absBD(newWei) < absBD(deltaWei)) {
      // the user withdrew from a positive balance to a negative one. Range cap it by newWei for borrow volume
      borrowVolumeToken = absBD(newWei)
    }

    // temporarily get rid of the old USD liquidity
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)

    token.borrowLiquidity = getMarketTotalBorrowWei(totalBorrowPar, token, index)
    token.borrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD)
    dolomiteMargin.totalBorrowVolumeUSD = dolomiteMargin.totalBorrowVolumeUSD.plus(borrowVolumeToken.times(tokenPriceUSD))
  } else if (isRepaymentOfBorrowAmount(newPar, deltaWei, index, token.decimals)) {
    // temporarily get rid of the old USD liquidity
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)

    token.borrowLiquidity = getMarketTotalBorrowWei(totalBorrowPar, token, index)
    token.borrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD)
  }

  if (!isVirtualTransfer) {
    // the balance change affected the ERC20.balanceOf(protocol)
    // temporarily get rid of the old USD liquidity
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

    token.supplyLiquidity = getMarketTotalSupplyWei(totalSupplyPar, token, index)
    token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD)

    if (deltaWei.gt(ZERO_BD)) {
      let deltaWeiUSD = deltaWei.times(tokenPriceUSD)
      dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deltaWeiUSD)
    }
  } else {
    // Adjust the liquidity of the protocol and token
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

    token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD)
  }

  dolomiteMargin.save()
  token.save()
}

export function invalidateMarginPosition(marginAccount: MarginAccount): void {
  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    let position = MarginPosition.load(marginAccount.id)
    if (position !== null) {
      position.status = MarginPositionStatus.Unknown
      position.save()
    }
  }
}

export function getLiquidationSpreadForPair(
  heldToken: Token,
  owedToken: Token,
  dolomiteMargin: DolomiteMargin
): BigDecimal {
  let heldRiskInfo = MarketRiskInfo.load(heldToken.marketId.toString()) as MarketRiskInfo
  let owedRiskInfo = MarketRiskInfo.load(owedToken.marketId.toString()) as MarketRiskInfo

  let liquidationSpread = dolomiteMargin.liquidationReward.minus(ONE_BD)
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(heldRiskInfo.liquidationRewardPremium))
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(owedRiskInfo.liquidationRewardPremium))

  return liquidationSpread
}
