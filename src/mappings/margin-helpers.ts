import {
  DolomiteMargin,
  InterestIndex,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  Token
} from '../types/schema'
import {
  absBD, BD_ONE_ETH,
  convertStructToDecimal,
  convertTokenToDecimal,
  createUserIfNecessary, ONE_BD,
  ONE_BI,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
} from './amm-helpers'
import { Address, BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts/index'
import { MarginPositionStatus, PositionChangeEvent, ProtocolType, ValueStruct } from './margin-types'
import { DOLOMITE_MARGIN_ADDRESS } from './generated/constants'
import { getTokenOraclePriceUSD } from './amm-pricing'

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

export function isMarginPositionExpired(marginPosition: MarginPosition, event: PositionChangeEvent): boolean {
  return marginPosition.expirationTimestamp !== null && (marginPosition.expirationTimestamp as BigInt).lt(event.timestamp)
}

export function getOrCreateDolomiteMarginForCall(
  event: ethereum.Event,
  isAction: boolean,
  protocolType: ProtocolType
): DolomiteMargin {
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS)
  if (dolomiteMargin === null) {
    dolomiteMargin = new DolomiteMargin(DOLOMITE_MARGIN_ADDRESS)

    dolomiteMargin.supplyLiquidityUSD = ZERO_BD
    dolomiteMargin.borrowLiquidityUSD = ZERO_BD

    dolomiteMargin.numberOfMarkets = 0

    if (protocolType === ProtocolType.Core) {
      let marginProtocol = Protocol
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH).plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH).plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH).div(BD_ONE_ETH)
    } else {
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH).plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH).plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH).div(BD_ONE_ETH)
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

export function weiToPar(wei: BigDecimal, index: InterestIndex, decimals: BigInt): BigDecimal {
  if (wei.ge(ZERO_BD)) {
    return wei.div(index.supplyIndex).truncate(decimals.toI32())
  } else {
    let smallestUnit = BigDecimal.fromString('1').div(new BigDecimal(BigInt.fromI32(10).pow(decimals.toI32() as u8)))
    return wei.div(index.borrowIndex).truncate(decimals.toI32()).minus(smallestUnit)
  }
}

export function parToWei(par: BigDecimal, index: InterestIndex): BigDecimal {
  let decimals = par.exp.lt(BigInt.fromI32(0)) ? par.exp.neg().toI32() as u8 : 0
  if (par.ge(ZERO_BD)) {
    return par.times(index.supplyIndex).truncate(decimals)
  } else {
    let oneWei = BigDecimal.fromString('1').div(new BigDecimal(BigInt.fromI32(10).pow(decimals)))
    return par.times(index.borrowIndex).truncate(decimals).minus(oneWei)
  }
}

function isRepaymentOfBorrowAmount(
  newPar: BigDecimal,
  deltaWei: BigDecimal,
  index: InterestIndex
): boolean {
  let newWei = parToWei(newPar, index)
  let oldWei = newWei.minus(deltaWei)
  return deltaWei.gt(ZERO_BD) && oldWei.lt(ZERO_BD) // the user added to the negative balance (decreasing it)
}

function getMarketTotalBorrowWei(
  borrowPar: BigInt,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals.toI32()
  return parToWei(convertTokenToDecimal(borrowPar.neg(), token.decimals), index).neg().truncate(decimals)
}

function getMarketTotalSupplyWei(
  supplyPar: BigInt,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals.toI32()
  return parToWei(convertTokenToDecimal(supplyPar, token.decimals), index).truncate(decimals)
}

export function changeProtocolBalance(
  token: Token,
  newParStruct: ValueStruct,
  deltaWeiStruct: ValueStruct,
  index: InterestIndex,
  isVirtualTransfer: boolean,
  totalBorrowPar: BigInt,
  totalSupplyPar: BigInt,
  dolomiteMargin: DolomiteMargin
): void {
  let tokenPriceUSD = getTokenOraclePriceUSD(token)

  let newPar = convertStructToDecimal(newParStruct, token.decimals)
  let newWei = parToWei(newPar, index)
  let deltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)

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
  } else if (isRepaymentOfBorrowAmount(newPar, deltaWei, index)) {
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
