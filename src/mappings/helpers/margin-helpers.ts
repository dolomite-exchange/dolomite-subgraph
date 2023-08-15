import { Address, BigDecimal, BigInt, ethereum, log, store } from '@graphprotocol/graph-ts'
import { DolomiteMargin as DolomiteMarginAdminProtocol } from '../../types/MarginAdmin/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryAdminProtocol } from '../../types/MarginAdmin/DolomiteMarginExpiry'
import { DolomiteMargin as DolomiteMarginCoreProtocol } from '../../types/MarginCore/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryCoreProtocol } from '../../types/MarginCore/DolomiteMarginExpiry'
import { DolomiteMargin as DolomiteMarginExpiryProtocol } from '../../types/MarginExpiry/DolomiteMargin'
import { DolomiteMarginExpiry as DolomiteMarginExpiryExpiryProtocol } from '../../types/MarginExpiry/DolomiteMarginExpiry'
import {
  DolomiteMargin,
  InterestIndex,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  MarketRiskInfo, MostRecentTrade,
  Token,
  TotalPar, Trade, Transfer, User,
} from '../../types/schema'
import { convertStructToDecimalAppliedValue } from './amm-helpers'
import {
  DOLOMITE_MARGIN_ADDRESS,
  EXPIRY_ADDRESS,
  FIVE_BD,
  _100_BI,
  ONE_BD,
  ONE_BI,
  ONE_ETH_BD,
  TEN_BI,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES,
  USD_PRECISION,
} from '../generated/constants'
import { absBD } from './helpers'
import { BalanceUpdate, MarginPositionStatus, ProtocolType, ValueStruct } from './margin-types'
import { getTokenOraclePriceUSD } from './pricing'
import { updateTimeDataForBorrow } from '../day-updates'
import { updateInterestRate } from '../interest-setter'
import { updateBorrowPositionForBalanceUpdate } from './borrow-position-helpers'
import { getEffectiveUserForAddressString } from './isolation-mode-helpers'
import { createUserIfNecessary } from './user-helpers'

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
    marginAccount.supplyTokens = []
    marginAccount.expirationTokens = []
    marginAccount.hasBorrowValue = false
    marginAccount.hasSupplyValue = false
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
    marginPosition.effectiveUser = getEffectiveUserForAddressString(account.user).id
    marginPosition.marginAccount = account.id
    marginPosition.isInitialized = false
    marginPosition.status = MarginPositionStatus.Open

    marginPosition.openTimestamp = event.block.timestamp
    marginPosition.openTransaction = event.transaction.hash.toHexString()

    marginPosition.marginDeposit = ZERO_BD
    marginPosition.marginDepositUSD = ZERO_BD
    marginPosition.initialMarginDeposit = ZERO_BD
    marginPosition.initialMarginDepositUSD = ZERO_BD

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
    dolomiteMargin.userCount = ZERO_BI
    dolomiteMargin.marginPositionCount = ZERO_BI
    dolomiteMargin.borrowPositionCount = ZERO_BI

    if (protocolType == ProtocolType.Core) {
      let marginProtocol = DolomiteMarginCoreProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryCoreProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = riskParams.maxNumberOfMarketsWithBalancesAndDebt
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else if (protocolType == ProtocolType.Admin) {
      let marginProtocol = DolomiteMarginAdminProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryAdminProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = riskParams.maxNumberOfMarketsWithBalancesAndDebt
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    } else {
      let marginProtocol = DolomiteMarginExpiryProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let expiryProtocol = DolomiteMarginExpiryExpiryProtocol.bind(Address.fromString(EXPIRY_ADDRESS))
      let riskParams = marginProtocol.getRiskParams()

      let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
      let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
      let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
      let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

      dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.liquidationReward = liquidationRewardBD.div(ONE_ETH_BD)
        .plus(ONE_BD)
      dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD)
      dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
        .div(ONE_ETH_BD)
      dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = riskParams.maxNumberOfMarketsWithBalancesAndDebt
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
    }

    dolomiteMargin.totalBorrowVolumeUSD = ZERO_BD
    dolomiteMargin.totalLiquidationVolumeUSD = ZERO_BD
    dolomiteMargin.totalSupplyVolumeUSD = ZERO_BD
    dolomiteMargin.totalTradeVolumeUSD = ZERO_BD
    dolomiteMargin.totalVaporizationVolumeUSD = ZERO_BD
    dolomiteMargin.totalZapVolumeUSD = ZERO_BD

    dolomiteMargin.lastTransactionHash = ZERO_BYTES

    dolomiteMargin.actionCount = ZERO_BI
    dolomiteMargin.liquidationCount = ZERO_BI
    dolomiteMargin.tradeCount = ZERO_BI
    dolomiteMargin.transactionCount = ZERO_BI
    dolomiteMargin.vaporizationCount = ZERO_BI
    dolomiteMargin.zapCount = ZERO_BI
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

export function canBeMarginPosition(marginAccount: MarginAccount): boolean {
  return marginAccount.accountNumber.ge(_100_BI)
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
  if (par.equals(ZERO_BD)) {
    return ZERO_BD
  } else if (par.gt(ZERO_BD)) {
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
  event: ethereum.Event
): MarginAccount {
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, event.block)
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

  if (tokenValue.valuePar.le(ZERO_BD) && balanceUpdate.valuePar.gt(ZERO_BD)) {
    // The user is going from a zero or negative balance to a positive one. Add to the list
    marginAccount.supplyTokens = marginAccount.supplyTokens.concat([balanceUpdate.token.id])
  } else if (tokenValue.valuePar.gt(ZERO_BD) && balanceUpdate.valuePar.le(ZERO_BD)) {
    // The user is going from a positive balance to a zero or negative one, remove it from the list
    let index = marginAccount.supplyTokens.indexOf(balanceUpdate.token.id)
    if (index != -1) {
      let copy = marginAccount.supplyTokens
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      marginAccount.supplyTokens = copy
    }
  }
  marginAccount.hasSupplyValue = marginAccount.supplyTokens.length > 0

  if (balanceUpdate.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.lt(tokenValue.valuePar)) {
    // The user is borrowing capital. The amount borrowed is capped at `neg(balanceUpdate.valuePar)`
    // reason being, the user can go from a +10 balance to -10; therefore the amount borrowed is 10 units, not 20
    let amountParBorrowed = absBD(balanceUpdate.valuePar).minus(tokenValue.valuePar)
    if (amountParBorrowed.gt(absBD(balanceUpdate.valuePar))) {
      amountParBorrowed = absBD(balanceUpdate.valuePar)
    }
    let interestIndex = InterestIndex.load(token.id) as InterestIndex
    let priceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
    let amountBorrowedUSD = parToWei(amountParBorrowed, interestIndex, token.decimals).times(priceUSD).truncate(USD_PRECISION)

    let user = User.load(marginAccount.user) as User
    user.totalBorrowVolumeOriginatedUSD = user.totalBorrowVolumeOriginatedUSD.plus(amountBorrowedUSD)
    user.save()
    if (user.effectiveUser != user.id) {
      let effectiveUser = User.load(user.effectiveUser) as User
      effectiveUser.totalBorrowVolumeOriginatedUSD = effectiveUser.totalBorrowVolumeOriginatedUSD.plus(amountBorrowedUSD)
      effectiveUser.save()
    }
  }

  tokenValue.valuePar = balanceUpdate.valuePar
  log.info(
    'Balance changed for account {} to value {}',
    [marginAccount.id, tokenValue.valuePar.toString()]
  )

  marginAccount.save()
  if (!deleteTokenValueIfNecessary(tokenValue)) {
    tokenValue.save()
  }

  updateBorrowPositionForBalanceUpdate(marginAccount, balanceUpdate, event)

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
  updateInterestRate(token, totalPar, index, dolomiteMargin)

  let tokenPriceUSD = getTokenOraclePriceUSD(token, event, protocolType)

  let deltaWei = convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals)

  // temporarily get rid of the old USD liquidity
  dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)
  dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

  let tokenBorrowLiquidity = absBD(parToWei(totalPar.borrowPar.neg(), index, token.decimals))
  let tokenBorrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD).truncate(USD_PRECISION)

  if (tokenBorrowLiquidity.gt(token.borrowLiquidity)) {
    let borrowVolumeToken = tokenBorrowLiquidity.minus(token.borrowLiquidity)
    let borrowVolumeUsd = borrowVolumeToken.times(tokenPriceUSD).truncate(USD_PRECISION)
    dolomiteMargin.totalBorrowVolumeUSD = dolomiteMargin.totalBorrowVolumeUSD.plus(borrowVolumeUsd)

    updateTimeDataForBorrow(token, event, borrowVolumeToken, borrowVolumeUsd)
  }

  token.borrowLiquidity = tokenBorrowLiquidity
  token.borrowLiquidityUSD = tokenBorrowLiquidityUSD
  token.supplyLiquidity = parToWei(totalPar.supplyPar, index, token.decimals)
  token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD).truncate(USD_PRECISION)

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
  if (canBeMarginPosition(marginAccount)) {
    let position = MarginPosition.load(marginAccount.id)
    if (position !== null && position.isInitialized) {
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

export function updateMarginPositionForTransfer(
  marginAccount1: MarginAccount,
  marginAccount2: MarginAccount,
  balanceUpdate1: BalanceUpdate,
  balanceUpdate2: BalanceUpdate,
  transfer: Transfer,
  event: ethereum.Event,
  token: Token,
  priceUSD: BigDecimal,
): void {
  if (marginAccount1.user == marginAccount2.user) {
    if (
      (!canBeMarginPosition(marginAccount1) && canBeMarginPosition(marginAccount2)) ||
      (!canBeMarginPosition(marginAccount2) && canBeMarginPosition(marginAccount1))
    ) {
      // The user is transferring from
      let marginPosition: MarginPosition
      if (canBeMarginPosition(marginAccount1)) {
        marginPosition = getOrCreateMarginPosition(event, marginAccount1)
      } else {
        marginPosition = getOrCreateMarginPosition(event, marginAccount2)
      }

      if (!marginPosition.isInitialized) {
        // GUARD STATEMENT
        return
      }

      // This is a real margin position
      transfer.isTransferForMarginPosition = true
      transfer.save()

      if (marginPosition.heldToken == token.id) {
        marginPosition.heldAmountPar = balanceUpdate1.marginAccount == marginPosition.marginAccount
          ? absBD(balanceUpdate1.valuePar)
          : absBD(balanceUpdate2.valuePar)
        if (
          marginPosition.status == MarginPositionStatus.Open
          && marginPosition.marginAccount == transfer.toMarginAccount
          && marginPosition.heldAmountPar.notEqual(ZERO_BD)
        ) {
          log.info(
            "Upsizing margin deposit for position {} with value {}",
            [marginAccount1.id, transfer.amountDeltaWei.toString()]
          )

          marginPosition.initialHeldAmountPar = marginPosition.heldAmountPar
          marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(transfer.amountDeltaWei)
          marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(transfer.amountUSDDeltaWei).truncate(USD_PRECISION)
          marginPosition.marginDeposit = marginPosition.marginDeposit.plus(transfer.amountDeltaWei)
          marginPosition.marginDepositUSD = marginPosition.marginDeposit.times(priceUSD).truncate(USD_PRECISION)
        } else if (
          marginPosition.status == MarginPositionStatus.Open
          && marginPosition.marginAccount == transfer.fromMarginAccount
          && marginPosition.heldAmountPar.notEqual(ZERO_BD)
        ) {
          log.info(
            "Downsizing margin deposit for position {} with value {}",
            [marginAccount1.id, transfer.amountDeltaWei.toString()]
          )

          if (transfer.amountDeltaWei.ge(marginPosition.marginDeposit)) {
            // Don't let the margin deposit go negative. Zero it out instead
            marginPosition.marginDeposit = ZERO_BD
          } else {
            marginPosition.marginDeposit = marginPosition.marginDeposit.minus(transfer.amountDeltaWei)
            marginPosition.initialHeldAmountPar = marginPosition.heldAmountPar
            marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.minus(transfer.amountDeltaWei)
            marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD
              .minus(transfer.amountDeltaWei.times(marginPosition.initialHeldPriceUSD))
              .truncate(USD_PRECISION)
          }
          marginPosition.marginDepositUSD = marginPosition.marginDeposit.times(priceUSD).truncate(USD_PRECISION)
        }
      } else if (token.id == marginPosition.owedToken) {
        marginPosition.owedAmountPar = balanceUpdate1.marginAccount == marginPosition.marginAccount
          ? absBD(balanceUpdate1.valuePar)
          : absBD(balanceUpdate2.valuePar)
      }

      marginPosition.save()
    }
  }
}
