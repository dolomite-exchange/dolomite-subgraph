import { Address, BigDecimal, BigInt, ethereum, log, store } from '@graphprotocol/graph-ts'
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
  MarketRiskInfo, MostRecentTrade,
  Token,
  TotalPar, Trade,
} from '../types/schema'
import { convertStructToDecimalAppliedValue, createUserIfNecessary } from './amm-helpers'
import {
  DOLOMITE_MARGIN_ADDRESS,
  EXPIRY_ADDRESS,
  FIVE_BD,
  ONE_BD,
  ONE_BI,
  ONE_ETH_BD,
  TEN_BI,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
} from './generated/constants'
import { absBD } from './helpers'
import { BalanceUpdate, MarginPositionStatus, ProtocolType, ValueStruct } from './margin-types'
import { getTokenOraclePriceUSD } from './pricing'
import { updateTimeDataForBorrow } from './day-updates'
import { updateInterestRate } from './interest-setter'

export function getIDForEvent(event: ethereum.Event): string {
  return `${event.transaction.hash.toHexString()}-${event.logIndex.toString()}`
}

export function getOrCreateTokenValue(
  marginAccount: MarginAccount,
  token: Token
): MarginAccountTokenValue {
  let id = `${marginAccount.user}-${marginAccount.accountNumber.toString()}-${token.marketId.toString()}`
  let tokenValue = MarginAccountTokenValue.load(id)
  if (tokenValue === null) {
    tokenValue = new MarginAccountTokenValue(id)
    tokenValue.marginAccount = marginAccount.id
    tokenValue.token = token.id
    tokenValue.valuePar = ZERO_BD
  }

  return tokenValue as MarginAccountTokenValue
}

export function deleteTokenValueIfNecessary(
  tokenValue: MarginAccountTokenValue
): boolean {
  if (
    tokenValue.valuePar.equals(ZERO_BD) &&
    tokenValue.expirationTimestamp === null &&
    tokenValue.expiryAddress === null
  ) {
    store.remove('MarginAccountTokenValue', tokenValue.id)
    return true
  }

  return false
}

export function getOrCreateMarginAccount(
  owner: Address,
  accountNumber: BigInt,
  block: ethereum.Block
): MarginAccount {
  let id = `${owner.toHexString()}-${accountNumber.toString()}`
  let marginAccount = MarginAccount.load(id)
  if (marginAccount === null) {
    createUserIfNecessary(owner)

    marginAccount = new MarginAccount(id)
    marginAccount.user = owner.toHexString()
    marginAccount.accountNumber = accountNumber
    marginAccount.borrowTokens = []
    marginAccount.expirationTokens = []
    marginAccount.hasBorrowValue = false
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

      let liquidationRatioBD = new BigDecimal(marginProtocol.getMarginRatio().value)
      let liquidationRewardBD = new BigDecimal(marginProtocol.getLiquidationSpread().value)
      let earningsRateBD = new BigDecimal(marginProtocol.getEarningsRate().value)
      let minBorrowedValueBD = new BigDecimal(marginProtocol.getMinBorrowedValue().value)
      let maxNumberOfMarketsWithBalancesAndDebt: BigInt
      let result = marginProtocol.try_getMaxNumberOfMarketsWithBalancesAndDebt()
      if (result.reverted) {
        maxNumberOfMarketsWithBalancesAndDebt = BigInt.fromI32(32)
      } else {
        maxNumberOfMarketsWithBalancesAndDebt = result.value
      }

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = maxNumberOfMarketsWithBalancesAndDebt
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else if (protocolType == ProtocolType.Admin) {
      let marginProtocol = DolomiteMarginAdminProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryAdminProtocol.bind(Address.fromString(EXPIRY_ADDRESS))

      let liquidationRatioBD = new BigDecimal(marginProtocol.getMarginRatio().value)
      let liquidationRewardBD = new BigDecimal(marginProtocol.getLiquidationSpread().value)
      let earningsRateBD = new BigDecimal(marginProtocol.getEarningsRate().value)
      let minBorrowedValueBD = new BigDecimal(marginProtocol.getMinBorrowedValue().value)
      let maxNumberOfMarketsWithBalancesAndDebt: BigInt
      let result = marginProtocol.try_getMaxNumberOfMarketsWithBalancesAndDebt()
      if (result.reverted) {
        maxNumberOfMarketsWithBalancesAndDebt = BigInt.fromI32(32)
      } else {
        maxNumberOfMarketsWithBalancesAndDebt = result.value
      }

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = maxNumberOfMarketsWithBalancesAndDebt
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else {
      let marginProtocol = DolomiteMarginExpiryProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryExpiryProtocol.bind(Address.fromString(EXPIRY_ADDRESS))

      let liquidationRatioBD = new BigDecimal(marginProtocol.getMarginRatio().value)
      let liquidationRewardBD = new BigDecimal(marginProtocol.getLiquidationSpread().value)
      let earningsRateBD = new BigDecimal(marginProtocol.getEarningsRate().value)
      let minBorrowedValueBD = new BigDecimal(marginProtocol.getMinBorrowedValue().value)
      let maxNumberOfMarketsWithBalancesAndDebt: BigInt
      let result = marginProtocol.try_getMaxNumberOfMarketsWithBalancesAndDebt()
      if (result.reverted) {
        maxNumberOfMarketsWithBalancesAndDebt = BigInt.fromI32(32)
      } else {
        maxNumberOfMarketsWithBalancesAndDebt = result.value
      }

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = maxNumberOfMarketsWithBalancesAndDebt
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

export function roundHalfUp(value: BigDecimal, decimals: BigInt): BigDecimal {
  // Add 0.5 to the number being truncated off. This allows us to effectively round up
  let amountToAdd = FIVE_BD.div(new BigDecimal(TEN_BI.pow((decimals.toI32() + 1) as u8)))

  if (value.lt(ZERO_BD)) {
    return value.minus(amountToAdd)
      .truncate(decimals.toI32())
  } else {
    return value.plus(amountToAdd)
      .truncate(decimals.toI32())
  }
}

// noinspection JSUnusedGlobalSymbols
export function weiToPar(
  wei: BigDecimal,
  index: InterestIndex,
  decimals: BigInt
): BigDecimal {
  if (wei.ge(ZERO_BD)) {
    return roundHalfUp(wei.div(index.supplyIndex), decimals)
  } else {
    return roundHalfUp(wei.div(index.borrowIndex), decimals)
  }
}

export function parToWei(
  par: BigDecimal,
  index: InterestIndex,
  decimals: BigInt
): BigDecimal {
  if (par.ge(ZERO_BD)) {
    return roundHalfUp(par.times(index.supplyIndex), decimals)
  } else {
    return roundHalfUp(par.times(index.borrowIndex), decimals)
  }
}

function handleTotalParChange(
  totalPar: TotalPar,
  oldPar: BigDecimal,
  newPar: BigDecimal
): void {
  // roll-back oldPar
  if (oldPar.ge(ZERO_BD)) {
    totalPar.supplyPar = totalPar.supplyPar.minus(oldPar)
  } else {
    totalPar.borrowPar = totalPar.borrowPar.minus(absBD(oldPar))
  }

  // roll-forward newPar
  if (newPar.ge(ZERO_BD)) {
    totalPar.supplyPar = totalPar.supplyPar.plus(newPar)
  } else {
    totalPar.borrowPar = totalPar.borrowPar.plus(absBD(newPar))
  }

  totalPar.save()
}

export function handleDolomiteMarginBalanceUpdateForAccount(
  balanceUpdate: BalanceUpdate,
  block: ethereum.Block
): MarginAccount {
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)
  let tokenValue = getOrCreateTokenValue(marginAccount, balanceUpdate.token)
  let token = Token.load(tokenValue.token) as Token

  let totalPar = TotalPar.load(token.id) as TotalPar
  handleTotalParChange(totalPar, tokenValue.valuePar, balanceUpdate.valuePar)

  if (tokenValue.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.ge(ZERO_BD)) {
    // The user is going from a negative balance to a positive one. Remove from the list
    let index = marginAccount.borrowTokens.indexOf(balanceUpdate.token.id)
    if (index != -1) {
      let copy = marginAccount.borrowTokens
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      marginAccount.borrowTokens = copy
    }
  } else if (tokenValue.valuePar.ge(ZERO_BD) && balanceUpdate.valuePar.lt(ZERO_BD)) {
    // The user is going from a positive balance to a negative one, add it to the list
    marginAccount.borrowTokens = marginAccount.borrowTokens.concat([balanceUpdate.token.id])
  }
  marginAccount.hasBorrowValue = marginAccount.borrowTokens.length > 0

  tokenValue.valuePar = balanceUpdate.valuePar
  log.info(
    'Balance changed for account {} to value {}',
    [marginAccount.id, tokenValue.valuePar.toString()]
  )

  marginAccount.save()
  if (!deleteTokenValueIfNecessary(tokenValue)) {
    tokenValue.save()
  }

  return marginAccount
}

export function saveMostRecentTrade(trade: Trade): void {
  let mostRecentTrade = MostRecentTrade.load(trade.takerToken)
  if (mostRecentTrade === null) {
    mostRecentTrade = new MostRecentTrade(trade.takerToken)
  }
  mostRecentTrade.trade = trade.id
  mostRecentTrade.save()

  mostRecentTrade = MostRecentTrade.load(trade.makerToken)
  if (mostRecentTrade === null) {
    mostRecentTrade = new MostRecentTrade(trade.makerToken)
  }
  mostRecentTrade.trade = trade.id
  mostRecentTrade.save()
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
  if (token.id != index.token) {
    log.error(
      'Token with address {} does not match index {} for event with hash {} and log index {}',
      [token.id, index.token, event.transaction.hash.toHexString(), event.logIndex.toString()]
    )
  }

  let totalPar = TotalPar.load(token.id) as TotalPar
  updateInterestRate(token, totalPar, index, dolomiteMargin, event)

  let tokenPriceUSD = getTokenOraclePriceUSD(token, event, protocolType)

  let newPar = convertStructToDecimalAppliedValue(newParStruct, token.decimals)
  let newWei = parToWei(newPar, index, token.decimals)
  let deltaWei = convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals)

  if (newPar.lt(ZERO_BD) && deltaWei.lt(ZERO_BD)) {
    // the user borrowed funds

    let borrowVolumeToken = absBD(deltaWei)
    if (absBD(newWei) < absBD(deltaWei)) {
      // the user withdrew from a positive balance to a negative one. Range cap it by newWei for borrow volume
      borrowVolumeToken = absBD(newWei)
    }

    let borrowVolumeUsd = borrowVolumeToken.times(tokenPriceUSD)
    dolomiteMargin.totalBorrowVolumeUSD = dolomiteMargin.totalBorrowVolumeUSD.plus(borrowVolumeUsd)

    updateTimeDataForBorrow(token, event, borrowVolumeToken, borrowVolumeUsd)
  }

  // temporarily get rid of the old USD liquidity
  dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)
  dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

  token.borrowLiquidity = absBD(parToWei(totalPar.borrowPar.neg(), index, token.decimals))
  token.borrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD)
  token.supplyLiquidity = parToWei(totalPar.supplyPar, index, token.decimals)
  token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD)

  // add the new liquidity back in
  dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD)
  dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD)

  if (!isVirtualTransfer) {
    // the balance change affected the ERC20.balanceOf(protocol)
    if (deltaWei.gt(ZERO_BD)) {
      // funds moved into DolomiteMargin
      let deltaWeiUSD = deltaWei.times(tokenPriceUSD)
      dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deltaWeiUSD)
    }
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
  let heldRiskInfo = MarketRiskInfo.load(heldToken.id) as MarketRiskInfo
  let owedRiskInfo = MarketRiskInfo.load(owedToken.id) as MarketRiskInfo

  let liquidationSpread = dolomiteMargin.liquidationReward.minus(ONE_BD)
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(heldRiskInfo.liquidationRewardPremium))
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(owedRiskInfo.liquidationRewardPremium))

  return liquidationSpread
}