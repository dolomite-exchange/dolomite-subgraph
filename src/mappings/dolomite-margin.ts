/* eslint-disable */
import {
  DolomiteMargin as DolomiteMarginProtocol,
  LogAddMarket as AddMarketEvent,
  LogRemoveMarket as RemoveMarketEvent,
  LogBuy as BuyEvent,
  LogDeposit as DepositEvent,
  LogIndexUpdate as IndexUpdateEvent,
  LogLiquidate as LiquidationEvent,
  LogOperation as OperationEvent,
  LogSell as SellEvent,
  LogSetEarningsRate as EarningsRateUpdateEvent,
  LogSetIsClosing as IsClosingUpdateEvent,
  LogSetMarginPremium as MarginPremiumUpdateEvent,
  LogSetSpreadPremium as MarketSpreadPremiumUpdateEvent,
  LogSetMarginRatio as MarginRatioUpdateEvent,
  LogSetLiquidationSpread as LiquidationSpreadUpdateEvent,
  LogSetMinBorrowedValue as MinBorrowedValueUpdateEvent,
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent
} from '../types/DolomiteMargin/DolomiteMargin'
import {
  ExpirySet as ExpirySetEvent
} from '../types/DolomiteMarginExpiry/DolomiteMarginExpiry'
import {
  MarginPositionClose as MarginPositionCloseEvent,
  MarginPositionOpen as MarginPositionOpenEvent
} from '../types/DolomiteAmmRouter/DolomiteAmmRouterProxy'
import {
  Bundle,
  Deposit,
  DolomiteMargin,
  InterestIndex,
  InterestRate,
  Liquidation,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  MarketRiskInfo,
  OraclePrice,
  Token,
  TokenMarketIdReverseMap,
  Trade,
  Transfer,
  Vaporization,
  Withdrawal
} from '../types/schema'
import {
  absBD,
  BD_ONE_ETH,
  BI_18,
  BI_ONE_ETH,
  bigDecimalExp18,
  changeProtocolBalance,
  convertStructToDecimal,
  convertTokenToDecimal,
  createUserIfNecessary, ONE_BD,
  ONE_BI,
  parToWei,
  SECONDS_IN_YEAR,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
} from './helpers'
import {
  DOLOMITE_MARGIN_ADDRESS
} from './generated/constants'
import { getOrCreateTransaction } from './core'
import { BalanceUpdate, MarginPositionStatus, PositionChangeEvent, ValueStruct } from './dolomite-margin-types'
import { Address, BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import {
  updateAndReturnTokenDayDataForMarginEvent,
  updateAndReturnTokenHourDataForMarginEvent,
  updateDolomiteDayData,
  updateTimeDataForLiquidation,
  updateTimeDataForTrade,
  updateTimeDataForVaporization
} from './day-updates'
import { initializeToken } from './helpers'
import { getTokenOraclePriceUSD } from './pricing'

function isMarginPositionExpired(marginPosition: MarginPosition, event: PositionChangeEvent): boolean {
  return marginPosition.expirationTimestamp !== null && (marginPosition.expirationTimestamp as BigInt).lt(event.timestamp)
}

function getOrCreateDolomiteMarginForCall(event: ethereum.Event, isAction: boolean): DolomiteMargin {
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS)
  if (dolomiteMargin === null) {
    dolomiteMargin = new DolomiteMargin(DOLOMITE_MARGIN_ADDRESS)

    dolomiteMargin.supplyLiquidityUSD = ZERO_BD
    dolomiteMargin.borrowLiquidityUSD = ZERO_BD

    dolomiteMargin.numberOfMarkets = 0

    let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
    let riskParams = marginProtocol.getRiskParams()

    let liquidationRatioBD = new BigDecimal(riskParams.marginRatio.value)
    let liquidationRewardBD = new BigDecimal(riskParams.liquidationSpread.value)
    let earningsRateBD = new BigDecimal(riskParams.earningsRate.value)
    let minBorrowedValueBD = new BigDecimal(riskParams.minBorrowedValue.value)

    dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH).plus(ONE_BD)
    dolomiteMargin.liquidationReward = liquidationRewardBD.div(BD_ONE_ETH).plus(ONE_BD)
    dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH)
    dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH).div(BD_ONE_ETH)

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

export function handleMarketAdded(event: AddMarketEvent): void {
  log.info(
    'Adding market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMarginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.numberOfMarkets = dolomiteMarginProtocol.getNumMarkets().toI32()
  dolomiteMargin.save()

  let id = event.params.marketId.toString()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [event.params.token.toHexString()])
    token = new Token(tokenAddress)
    initializeToken(token as Token, event.params.marketId)
    token.save()
  }

  let index = new InterestIndex(id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.token = token.id
  index.save()

  let interestRate = new InterestRate(id)
  interestRate.borrowInterestRate = ZERO_BD
  interestRate.supplyInterestRate = ZERO_BD
  interestRate.token = token.id
  interestRate.save()

  let oraclePrice = new OraclePrice(id)
  oraclePrice.price = ZERO_BD
  oraclePrice.save()
}

export function handleMarketRemoved(event: RemoveMarketEvent): void {
  log.info(
    'Removing market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.numberOfMarkets = dolomiteMargin.numberOfMarkets + 1
  dolomiteMargin.save()

  let id = event.params.marketId.toString()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [event.params.token.toHexString()])
    token = new Token(tokenAddress)
    initializeToken(token as Token, event.params.marketId)
    token.save()
  }

  let index = new InterestIndex(id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.token = token.id
  index.save()

  let interestRate = new InterestRate(id)
  interestRate.borrowInterestRate = ZERO_BD
  interestRate.supplyInterestRate = ZERO_BD
  interestRate.token = token.id
  interestRate.save()

  let oraclePrice = new OraclePrice(id)
  oraclePrice.price = ZERO_BD
  oraclePrice.save()
}

export function handleEarningsRateUpdate(event: EarningsRateUpdateEvent): void {
  log.info(
    'Handling earnings rate change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let earningsRateBD = new BigDecimal(event.params.earningsRate.value)
  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH) // it's a ratio where ONE_ETH is 100%
  dolomiteMargin.save()

  let numMarkets = dolomiteMargin.numberOfMarkets

  for (let i = 0; i < numMarkets; i++) {
    let interestRate = InterestRate.load(i.toString()) as InterestRate
    interestRate.supplyInterestRate = interestRate.borrowInterestRate.times(dolomiteMargin.earningsRate).truncate(18)
    interestRate.save()
  }
}

export function handleSetLiquidationReward(event: LiquidationSpreadUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let liquidationPremiumBD = new BigDecimal(event.params.liquidationSpread.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.liquidationReward = liquidationPremiumBD.div(BD_ONE_ETH).plus(ONE_BD)
  dolomiteMargin.save()
}

export function handleSetLiquidationRatio(event: MarginRatioUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let liquidationRatioBD = new BigDecimal(event.params.marginRatio.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH).plus(ONE_BD)
  dolomiteMargin.save()
}

export function handleSetMinBorrowedValue(event: MinBorrowedValueUpdateEvent): void {
  log.info(
    'Handling min borrowed value change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let minBorrowedValueBD = new BigDecimal(event.params.minBorrowedValue.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false)
  dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH).div(BD_ONE_ETH)
  dolomiteMargin.save()
}

export function handleSetMarginPremium(event: MarginPremiumUpdateEvent): void {
  log.info(
    'Handling margin premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.liquidationRewardPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  let marginPremium = new BigDecimal(event.params.marginPremium.value)
  marketInfo.marginPremium = marginPremium.div(BD_ONE_ETH)
  marketInfo.save()
}

export function handleSetLiquidationSpreadPremium(event: MarketSpreadPremiumUpdateEvent): void {
  log.info(
    'Handling liquidation spread premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.marginPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  let spreadPremium = new BigDecimal(event.params.spreadPremium.value)
  marketInfo.liquidationRewardPremium = spreadPremium.div(BD_ONE_ETH)
  marketInfo.save()
}

export function handleSetIsMarketClosing(event: IsClosingUpdateEvent): void {
  log.info(
    'Handling set_market_closing for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.marginPremium = ZERO_BD
    marketInfo.liquidationRewardPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  marketInfo.isBorrowingDisabled = event.params.isClosing
  marketInfo.save()
}

export function handleOperation(event: OperationEvent): void {
  let bundle = Bundle.load('1') as Bundle
  if (bundle.priceOracleLastUpdatedBlockHash != event.block.hash.toHexString()) {
    bundle.priceOracleLastUpdatedBlockHash = event.block.hash.toHexString()

    let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
    let marketCount = marginProtocol.getNumMarkets().toI32()
    for (let marketId = 0; marketId < marketCount; marketId++) {
      let oraclePrice = OraclePrice.load(marketId.toString()) as OraclePrice
      let token = Token.load(marginProtocol.getMarketTokenAddress(BigInt.fromI32(marketId)).toHexString()) as Token

      let tokenAmountBI = marginProtocol.getMarketPrice(BigInt.fromI32(marketId)).value
      oraclePrice.price = convertTokenToDecimal(tokenAmountBI, BigInt.fromI32(36 - token.decimals.toI32()))
      oraclePrice.save()
    }
  }
}

export function handleIndexUpdate(event: IndexUpdateEvent): void {
  log.info(
    'Handling index update for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let id = event.params.market.toString()
  let index = InterestIndex.load(id)
  if (index === null) {
    index = new InterestIndex(id)
  }

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let indexResult = marginProtocol.getMarketCurrentIndex(event.params.market)
  index.borrowIndex = convertTokenToDecimal(indexResult.borrow, BI_18)
  index.supplyIndex = convertTokenToDecimal(indexResult.supply, BI_18)
  index.lastUpdate = event.params.index.lastUpdate
  index.save()

  let interestRatePerSecond = marginProtocol.getMarketInterestRate(event.params.market).value
  let interestPerYearBD = new BigDecimal(interestRatePerSecond.times(SECONDS_IN_YEAR))
  let earningsRateMax = new BigDecimal(marginProtocol.getRiskLimits().earningsRateMax)
  let earningsRate = new BigDecimal(marginProtocol.getEarningsRate().value)

  let interestRate = InterestRate.load(id) as InterestRate
  interestRate.borrowInterestRate = interestPerYearBD.div(bigDecimalExp18())
  interestRate.supplyInterestRate = interestRate.borrowInterestRate.times(earningsRate).div(earningsRateMax)
  interestRate.save()
}

function getOrCreateMarginAccount(owner: Address, accountNumber: BigInt, block: ethereum.Block): MarginAccount {
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

function getOrCreateTokenValue(
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

function handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate: BalanceUpdate, block: ethereum.Block): MarginAccount {
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)

  let tokenValue = getOrCreateTokenValue(marginAccount, balanceUpdate.token)

  if (tokenValue.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.ge(ZERO_BD)) {
    // The user is going from a negative balance to a positive one. Remove from the list
    let index = marginAccount.borrowedMarketIds.indexOf(tokenValue.id)
    if (index != -1) {
      let arrayCopy = marginAccount.borrowedMarketIds
      arrayCopy.splice(index, 1)
      marginAccount.borrowedMarketIds = arrayCopy
    }
  } else if (tokenValue.valuePar.ge(ZERO_BD) && balanceUpdate.valuePar.lt(ZERO_BD)) {
    // The user is going from a positive balance to a negative one, add it to the list
    marginAccount.borrowedMarketIds = marginAccount.borrowedMarketIds.concat([tokenValue.id])
  }
  marginAccount.hasBorrowedValue = marginAccount.borrowedMarketIds.length > 0

  tokenValue.valuePar = balanceUpdate.valuePar
  log.info(
    'Balance changed for account {} to value {}',
    [marginAccount.id, tokenValue.valuePar.toString()]
  )

  marginAccount.save()
  tokenValue.save()

  return marginAccount
}

function getIDForEvent(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + '-' + event.logIndex.toString()
}

function getOrCreateMarginPosition(event: ethereum.Event, account: MarginAccount): MarginPosition {
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

function updateMarginPositionForTrade(
  marginPosition: MarginPosition,
  event: PositionChangeEvent,
  dolomiteMarginProtocol: DolomiteMarginProtocol,
  inputTokenNewPar: ValueStruct,
  outputTokenNewPar: ValueStruct,
  inputTokenIndex: InterestIndex,
  outputTokenIndex: InterestIndex
): void {
  let isPositionBeingOpened = false
  if (marginPosition.owedToken === null || marginPosition.heldToken === null) {
    // the position is being opened
    isPositionBeingOpened = true
    marginPosition.owedToken = event.inputToken.id
    marginPosition.heldToken = event.outputToken.id
  }

  if (!isPositionBeingOpened) {
    let tokens = [marginPosition.heldToken, marginPosition.owedToken]
    if (
      marginPosition.status == MarginPositionStatus.Unknown ||
      !tokens.includes(event.inputToken.id) ||
      !tokens.includes(event.outputToken.id) ||
      !tokens.includes(event.depositToken.id)
    ) {
      // the position is invalidated
      marginPosition.status = MarginPositionStatus.Unknown
      marginPosition.save()
      return
    }
  }

  let heldToken: Token = Token.load(marginPosition.heldToken as string) as Token
  let owedToken: Token = Token.load(marginPosition.owedToken as string) as Token

  const heldTokenNewPar = marginPosition.heldToken == event.inputToken.id ?
    absBD(convertStructToDecimal(inputTokenNewPar, heldToken.decimals)) :
    absBD(convertStructToDecimal(outputTokenNewPar, heldToken.decimals))

  const owedTokenNewPar = marginPosition.owedToken == event.inputToken.id ?
    absBD(convertStructToDecimal(inputTokenNewPar, owedToken.decimals)) :
    absBD(convertStructToDecimal(outputTokenNewPar, owedToken.decimals))

  let heldTokenIndex = marginPosition.heldToken == event.inputToken.id ? inputTokenIndex : outputTokenIndex
  let owedTokenIndex = marginPosition.owedToken == event.inputToken.id ? inputTokenIndex : outputTokenIndex

  // if the trader is closing the position, they are sizing down the collateral and debt
  let inputAmountWei = !event.isOpen ? event.inputWei.neg() : event.inputWei
  let outputAmountWei = !event.isOpen ? event.outputWei.neg() : event.outputWei

  let heldAmountWei = marginPosition.heldToken == event.inputToken.id ? inputAmountWei : outputAmountWei
  let owedAmountWei = marginPosition.owedToken == event.inputToken.id ? inputAmountWei : outputAmountWei

  marginPosition.owedAmountPar = owedTokenNewPar
  marginPosition.heldAmountPar = heldTokenNewPar

  if (isPositionBeingOpened) {
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken)
    let heldPriceUSD = getTokenOraclePriceUSD(heldToken)

    marginPosition.initialOwedAmountPar = owedTokenNewPar
    marginPosition.initialOwedAmountWei = owedAmountWei
    marginPosition.initialOwedPrice = absBD(heldAmountWei).div(absBD(owedAmountWei)).truncate(36)
    marginPosition.initialOwedPriceUSD = marginPosition.initialOwedPrice.times(heldPriceUSD).truncate(36)
    marginPosition.initialOwedAmountUSD = owedAmountWei.times(marginPosition.initialOwedPriceUSD).truncate(36)

    marginPosition.initialHeldAmountPar = heldTokenNewPar
    marginPosition.initialHeldAmountWei = heldAmountWei
    if (marginPosition.heldToken == event.depositToken.id) {
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(event.depositWei)
    }
    marginPosition.initialHeldPrice = absBD(owedAmountWei).div(absBD(heldAmountWei)).truncate(36)
    marginPosition.initialHeldPriceUSD = marginPosition.initialHeldPrice.times(owedPriceUSD).truncate(36)
    marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountWei.times(marginPosition.initialHeldPriceUSD).truncate(36)

    marginPosition.marginDeposit = event.depositWei
    marginPosition.marginDepositUSD = event.depositWei.times(marginPosition.initialHeldPriceUSD)
  }


  if (marginPosition.owedAmountPar.equals(ZERO_BD)) {
    marginPosition.status = isMarginPositionExpired(marginPosition, event) ? MarginPositionStatus.Expired : MarginPositionStatus.Closed
    marginPosition.closeTimestamp = event.timestamp
    marginPosition.closeTransaction = event.hash.toHexString()

    let heldPriceUSD = getTokenOraclePriceUSD(heldToken)
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

    marginPosition.closeHeldPrice = owedAmountWei.div(heldAmountWei).truncate(36)
    marginPosition.closeHeldPriceUSD = (marginPosition.closeHeldPrice as BigDecimal).times(owedPriceUSD).truncate(36)
    marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldTokenIndex.supplyIndex)
    marginPosition.closeHeldAmountUSD = (marginPosition.closeHeldAmountWei as BigDecimal).times(heldPriceUSD)

    marginPosition.closeOwedPrice = heldAmountWei.div(owedAmountWei).truncate(36)
    marginPosition.closeOwedPriceUSD = (marginPosition.closeOwedPrice as BigDecimal).times(heldPriceUSD).truncate(36)
    marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex.borrowIndex)
    marginPosition.closeOwedAmountUSD = (marginPosition.closeOwedAmountWei as BigDecimal).times(owedPriceUSD)
  }

  let tokenValue = getOrCreateTokenValue(MarginAccount.load(marginPosition.marginAccount)!, owedToken)
  if (tokenValue.expirationTimestamp !== null) {
    marginPosition.expirationTimestamp = tokenValue.expirationTimestamp
  }

  marginPosition.save()
}

export function handleDeposit(event: DepositEvent): void {
  log.info(
    'Handling deposit for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let token = Token.load(marginProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let depositID = getIDForEvent(event)
  let deposit = Deposit.load(depositID)
  if (deposit === null) {
    deposit = new Deposit(depositID)
    deposit.serialId = dolomiteMargin.actionCount
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let newParStruct = new ValueStruct(event.params.update.newPar)

  deposit.transaction = transaction.id
  deposit.logIndex = event.logIndex
  deposit.marginAccount = marginAccount.id
  deposit.token = token.id
  deposit.from = event.params.from
  deposit.amountDeltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)
  deposit.amountUSDDeltaWei = deposit.amountDeltaWei.times(getTokenOraclePriceUSD(token)).truncate(18)

  dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei)

  let marketIndex = InterestIndex.load(event.params.market.toString()) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStruct, marketIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  marginAccount.save()
  deposit.save()
  transaction.save()

  updateAndReturnTokenDayDataForMarginEvent(token, event)
  updateAndReturnTokenHourDataForMarginEvent(token, event)
}

export function handleWithdraw(event: WithdrawEvent): void {
  log.info(
    'Handling withdrawal for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let token = Token.load(marginProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let withdrawalID = getIDForEvent(event)
  let withdrawal = Withdrawal.load(withdrawalID)
  if (withdrawal === null) {
    withdrawal = new Withdrawal(withdrawalID)
    withdrawal.serialId = dolomiteMargin.actionCount
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let deltaWeiStructAbs = deltaWeiStruct.abs()
  let newParStruct = new ValueStruct(event.params.update.newPar)

  withdrawal.transaction = transaction.id
  withdrawal.logIndex = event.logIndex
  withdrawal.marginAccount = marginAccount.id
  withdrawal.token = token.id
  withdrawal.to = event.params.to
  withdrawal.amountDeltaWei = convertStructToDecimal(deltaWeiStructAbs, token.decimals)
  withdrawal.amountUSDDeltaWei = withdrawal.amountDeltaWei.times(getTokenOraclePriceUSD(token)).truncate(18)

  marginAccount.save()
  withdrawal.save()
  transaction.save()

  updateDolomiteDayData(event)

  let marketIndex = InterestIndex.load(event.params.market.toString()) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStructAbs.neg(), marketIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  updateAndReturnTokenHourDataForMarginEvent(token, event)
  updateAndReturnTokenDayDataForMarginEvent(token, event)
}

export function handleTransfer(event: TransferEvent): void {
  log.info(
    'Handling transfer for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let token = Token.load(TokenMarketIdReverseMap.load(event.params.market.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign,
    token
  )
  let marginAccount1 = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign,
    token
  )
  let marginAccount2 = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let transferID = getIDForEvent(event)
  let transfer = Transfer.load(transferID)
  if (transfer === null) {
    transfer = new Transfer(transferID)
    transfer.serialId = dolomiteMargin.actionCount
  }

  transfer.transaction = transaction.id
  transfer.logIndex = event.logIndex

  transfer.fromMarginAccount = event.params.updateOne.deltaWei.sign ? marginAccount2.id : marginAccount1.id
  transfer.toMarginAccount = event.params.updateOne.deltaWei.sign ? marginAccount1.id : marginAccount2.id
  transfer.isSelfTransfer = transfer.fromMarginAccount == transfer.toMarginAccount
  transfer.walletsConcatenated = marginAccount1.user + '_' + marginAccount2.user

  transfer.token = token.id

  let amountDeltaWei = new ValueStruct(event.params.updateOne.deltaWei)
  let priceUSD = getTokenOraclePriceUSD(token)
  transfer.amountDeltaWei = convertStructToDecimal(amountDeltaWei.abs(), token.decimals)
  transfer.amountUSDDeltaWei = transfer.amountDeltaWei.times(priceUSD).truncate(18)

  marginAccount1.save()
  marginAccount2.save()
  transfer.save()
  transaction.save()

  let marketIndex = InterestIndex.load(token.marketId.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(
    token,
    new ValueStruct(event.params.updateOne.newPar),
    new ValueStruct(event.params.updateOne.deltaWei),
    marketIndex,
    isVirtualTransfer,
    dolomiteMargin,
    marginProtocol
  )
  changeProtocolBalance(
    token,
    new ValueStruct(event.params.updateTwo.newPar),
    new ValueStruct(event.params.updateTwo.deltaWei),
    marketIndex,
    isVirtualTransfer,
    dolomiteMargin,
    marginProtocol
  )

  if (marginAccount1.user == marginAccount2.user) {
    if (marginAccount1.accountNumber.equals(ZERO_BI) && marginAccount2.accountNumber.notEqual(ZERO_BI)) {
      let marginPosition = getOrCreateMarginPosition(event, marginAccount2)
      if (marginPosition.marginDeposit.notEqual(ZERO_BD)) {
        // The user is transferring collateral
        if (marginPosition.status == MarginPositionStatus.Open && marginPosition.heldToken == token.id) {
          marginPosition.heldAmountPar = balanceUpdateTwo.valuePar
        } else if (marginPosition.status == MarginPositionStatus.Open && token.id == marginPosition.owedToken) {
          marginPosition.owedAmountPar = absBD(balanceUpdateOne.valuePar)
        }

        marginPosition.save()
      }
    } else if (marginAccount2.accountNumber.equals(ZERO_BI) && marginAccount1.accountNumber.notEqual(ZERO_BI)) {
      let marginPosition = getOrCreateMarginPosition(event, marginAccount1)
      if (marginPosition.marginDeposit.notEqual(ZERO_BD)) {
        // The user is removing collateral
        if (marginPosition.status == MarginPositionStatus.Open && token.id == marginPosition.heldToken) {
          marginPosition.heldAmountPar = balanceUpdateOne.valuePar
        } else if (marginPosition.status == MarginPositionStatus.Open && token.id == marginPosition.owedToken) {
          marginPosition.owedAmountPar = absBD(balanceUpdateOne.valuePar)
        }

        marginPosition.save()
      }
    }
  }

  updateAndReturnTokenHourDataForMarginEvent(token, event)
  updateAndReturnTokenDayDataForMarginEvent(token, event)
}

export function handleBuy(event: BuyEvent): void {
  log.info(
    'Handling BUY for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let makerToken = Token.load(TokenMarketIdReverseMap.load(event.params.makerMarket.toString())!.tokenAddress) as Token
  let takerToken = Token.load(TokenMarketIdReverseMap.load(event.params.takerMarket.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    makerToken
  )
  // Don't do a variable assignment here since it's overwritten below
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    takerToken
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = marginAccount.id
  trade.makerMarginAccount = null
  trade.walletsConcatenated = marginAccount.user

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerDeltaWeiStruct.abs(), takerToken.decimals)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei.times(getTokenOraclePriceUSD(takerToken)).truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let inputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)
}

export function handleSell(event: SellEvent): void {
  log.info(
    'Handling SELL for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let makerToken = Token.load(TokenMarketIdReverseMap.load(event.params.makerMarket.toString())!.tokenAddress) as Token
  let takerToken = Token.load(TokenMarketIdReverseMap.load(event.params.takerMarket.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    makerToken
  )
  // Don't do a variable assignment here since it's overwritten below
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    takerToken
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = marginAccount.id
  trade.makerMarginAccount = null
  trade.walletsConcatenated = marginAccount.user

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerDeltaWeiStruct.abs(), takerToken.decimals)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei.times(getTokenOraclePriceUSD(takerToken)).truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let inputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)
}

export function handleTrade(event: TradeEvent): void {
  log.info(
    'Handling trade for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let takerToken = Token.load(TokenMarketIdReverseMap.load(event.params.inputMarket.toString())!.tokenAddress) as Token
  let makerToken = Token.load(TokenMarketIdReverseMap.load(event.params.outputMarket.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign,
    takerToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign,
    makerToken
  )
  let makerMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign,
    takerToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign,
    makerToken
  )
  let takerMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = takerMarginAccount.id
  trade.makerMarginAccount = makerMarginAccount.id
  trade.walletsConcatenated = takerMarginAccount.user + '_' + makerMarginAccount.user

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerInputDeltaWeiStruct = new ValueStruct(event.params.takerInputUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerInputDeltaWeiStruct.abs(), takerToken.decimals)

  let takerOutputDeltaWeiStruct = new ValueStruct(event.params.takerOutputUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimal(takerOutputDeltaWeiStruct.abs(), makerToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei.times(getTokenOraclePriceUSD(takerToken)).truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let takerIndex = InterestIndex.load(event.params.inputMarket.toString()) as InterestIndex
  let makerIndex = InterestIndex.load(event.params.outputMarket.toString()) as InterestIndex
  let isVirtualTransfer = true

  let takerInputNewParStruct = new ValueStruct(event.params.takerInputUpdate.newPar)
  changeProtocolBalance(takerToken, takerInputNewParStruct, takerInputDeltaWeiStruct, takerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let takerOutputNewParStruct = new ValueStruct(event.params.takerOutputUpdate.newPar)
  changeProtocolBalance(makerToken, takerOutputNewParStruct, takerOutputDeltaWeiStruct, makerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let makerInputNewParStruct = new ValueStruct(event.params.makerInputUpdate.newPar)
  let makerInputDeltaWeiStruct = new ValueStruct(event.params.makerInputUpdate.deltaWei)
  changeProtocolBalance(makerToken, makerInputNewParStruct, makerInputDeltaWeiStruct, takerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let makerOutputNewParStruct = new ValueStruct(event.params.makerOutputUpdate.newPar)
  let makerOutputDeltaWeiStruct = new ValueStruct(event.params.makerOutputUpdate.deltaWei)
  changeProtocolBalance(takerToken, makerOutputNewParStruct, makerOutputDeltaWeiStruct, makerIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let takerTokenHourData = updateAndReturnTokenHourDataForMarginEvent(takerToken, event)
  let makerTokenHourData = updateAndReturnTokenHourDataForMarginEvent(makerToken, event)
  let takerTokenDayData = updateAndReturnTokenDayDataForMarginEvent(takerToken, event)
  let makerTokenDayData = updateAndReturnTokenDayDataForMarginEvent(makerToken, event)

  updateTimeDataForTrade(dolomiteDayData, makerTokenDayData, makerTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, takerTokenDayData, takerTokenHourData, takerToken, trade as Trade)
}

export function handleLiquidate(event: LiquidationEvent): void {
  log.info(
    'Handling liquidate for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let heldToken = Token.load(TokenMarketIdReverseMap.load(event.params.heldMarket.toString())!.tokenAddress) as Token
  let owedToken = Token.load(TokenMarketIdReverseMap.load(event.params.owedMarket.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign,
    owedToken
  )
  let liquidMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    owedToken
  )
  let solidMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let liquidationID = getIDForEvent(event)
  let liquidation = Liquidation.load(liquidationID)
  if (liquidation === null) {
    liquidation = new Liquidation(liquidationID)
    liquidation.serialId = dolomiteMargin.actionCount
  }

  liquidation.transaction = transaction.id
  liquidation.logIndex = event.logIndex

  liquidation.liquidMarginAccount = liquidMarginAccount.id
  liquidation.solidMarginAccount = solidMarginAccount.id

  liquidation.heldToken = heldToken.id
  liquidation.borrowedToken = owedToken.id

  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  let solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  liquidation.heldTokenAmountDeltaWei = convertStructToDecimal(solidHeldDeltaWeiStruct.abs(), heldToken.decimals)

  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  let solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  liquidation.borrowedTokenAmountDeltaWei = convertStructToDecimal(solidOwedDeltaWeiStruct.abs(), owedToken.decimals)

  let liquidHeldDeltaWeiStruct = new ValueStruct(event.params.liquidHeldUpdate.deltaWei)
  let liquidHeldNewParStruct = new ValueStruct(event.params.liquidHeldUpdate.newPar)

  let liquidOwedDeltaWeiStruct = new ValueStruct(event.params.liquidOwedUpdate.deltaWei)
  let liquidOwedNewParStruct = new ValueStruct(event.params.liquidOwedUpdate.newPar)

  let heldPriceUSD = getTokenOraclePriceUSD(heldToken)
  let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

  let liquidationSpread = marginProtocol.getLiquidationSpreadForPair(event.params.heldMarket, event.params.owedMarket).value
  let heldDeltaWei = event.params.solidHeldUpdate.deltaWei.value
  let heldTokenLiquidationRewardWei = heldDeltaWei.minus(heldDeltaWei.times(BI_ONE_ETH).div(liquidationSpread))
  liquidation.heldTokenLiquidationRewardWei = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)

  let liquidOwedDeltaWeiBD = convertStructToDecimal(liquidOwedDeltaWeiStruct, owedToken.decimals)
  liquidation.debtUSDLiquidated = liquidOwedDeltaWeiBD.times(owedPriceUSD).truncate(18)

  let liquidHeldDeltaWeiBD = convertStructToDecimal(liquidHeldDeltaWeiStruct, heldToken.decimals)
  liquidation.collateralUSDLiquidated = liquidHeldDeltaWeiBD.times(heldPriceUSD).truncate(18)

  let heldTokenLiquidationRewardWeiBD = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)
  liquidation.collateralUSDLiquidationReward = heldTokenLiquidationRewardWeiBD.times(heldPriceUSD).truncate(18)

  dolomiteMargin.liquidationCount = dolomiteMargin.liquidationCount.plus(ONE_BI)
  dolomiteMargin.totalLiquidationVolumeUSD = dolomiteMargin.totalLiquidationVolumeUSD.plus(liquidation.debtUSDLiquidated)
  dolomiteMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)
  changeProtocolBalance(heldToken, liquidHeldNewParStruct, liquidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)
  changeProtocolBalance(owedToken, liquidOwedNewParStruct, liquidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let heldTokenHourData = updateAndReturnTokenHourDataForMarginEvent(heldToken, event)
  let owedTokenHourData = updateAndReturnTokenHourDataForMarginEvent(owedToken, event)
  let heldTokenDayData = updateAndReturnTokenDayDataForMarginEvent(heldToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForMarginEvent(owedToken, event)

  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForLiquidation(dolomiteDayData, heldTokenDayData, heldTokenHourData, heldToken, liquidation as Liquidation)
  updateTimeDataForLiquidation(dolomiteDayData, owedTokenDayData, owedTokenHourData, owedToken, liquidation as Liquidation)

  liquidMarginAccount.save()
  solidMarginAccount.save()
  liquidation.save()
  transaction.save()

  if (liquidMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, liquidMarginAccount)
    if (marginPosition.status == MarginPositionStatus.Open || marginPosition.status == MarginPositionStatus.Liquidated) {
      marginPosition.status = MarginPositionStatus.Liquidated
      if (marginPosition.closeTimestamp === null) {
        marginPosition.closeTimestamp = event.block.timestamp
        marginPosition.closeTransaction = event.transaction.hash.toHexString()
      }

      marginPosition.heldAmountPar = convertStructToDecimal(liquidHeldNewParStruct, heldToken.decimals)
      marginPosition.owedAmountPar = convertStructToDecimal(liquidOwedNewParStruct, owedToken.decimals)

      if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
        let heldPriceUSD = getTokenOraclePriceUSD(heldToken)
        let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

        let closeHeldAmountWei = parToWei(marginPosition.initialHeldAmountPar, heldIndex)
        let closeOwedAmountWei = parToWei(marginPosition.initialOwedAmountPar.neg(), owedIndex).neg()

        marginPosition.closeHeldPriceUSD = closeHeldAmountWei.div(closeOwedAmountWei).times(owedPriceUSD).truncate(36)
        marginPosition.closeHeldAmountWei = closeHeldAmountWei
        marginPosition.closeHeldAmountUSD = closeHeldAmountWei.times(heldPriceUSD).truncate(18)

        marginPosition.closeOwedPriceUSD = closeOwedAmountWei.div(closeHeldAmountWei).times(heldPriceUSD).truncate(36)
        marginPosition.closeOwedAmountWei = closeOwedAmountWei
        marginPosition.closeOwedAmountUSD = closeOwedAmountWei.times(owedPriceUSD).truncate(18)
      }

      marginPosition.save()
    }
  }
}

export function handleVaporize(event: VaporizationEvent): void {
  log.info(
    'Handling vaporize for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(event.address)
  let heldToken = Token.load(TokenMarketIdReverseMap.load(event.params.heldMarket.toString())!.tokenAddress) as Token
  let owedToken = Token.load(TokenMarketIdReverseMap.load(event.params.owedMarket.toString())!.tokenAddress) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign,
    owedToken
  )
  let vaporMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    owedToken
  )
  let solidMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let transaction = getOrCreateTransaction(event)

  let vaporOwedNewParStruct = new ValueStruct(event.params.vaporOwedUpdate.newPar)
  let vaporOwedDeltaWeiStruct = new ValueStruct(event.params.vaporOwedUpdate.deltaWei)

  let solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)

  let solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true)

  let vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
    vaporization.serialId = dolomiteMargin.actionCount
  }

  vaporization.transaction = transaction.id
  vaporization.logIndex = event.logIndex

  vaporization.vaporMarginAccount = vaporMarginAccount.id
  vaporization.solidMarginAccount = solidMarginAccount.id

  vaporization.heldToken = heldToken.id
  vaporization.borrowedToken = owedToken.id

  let borrowedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  vaporization.borrowedTokenAmountDeltaWei = convertStructToDecimal(borrowedDeltaWeiStruct.abs(), owedToken.decimals)

  let heldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  vaporization.heldTokenAmountDeltaWei = convertStructToDecimal(heldDeltaWeiStruct.abs(), heldToken.decimals)

  let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

  let vaporOwedDeltaWeiBD = convertStructToDecimal(vaporOwedDeltaWeiStruct, owedToken.decimals)
  vaporization.amountUSDVaporized = vaporOwedDeltaWeiBD.times(owedPriceUSD).truncate(18)

  dolomiteMargin.vaporizationCount = dolomiteMargin.vaporizationCount.plus(ONE_BI)
  dolomiteMargin.totalVaporizationVolumeUSD = dolomiteMargin.totalVaporizationVolumeUSD.plus(vaporization.amountUSDVaporized)
  dolomiteMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)
  changeProtocolBalance(owedToken, vaporOwedNewParStruct, vaporOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, dolomiteMargin, marginProtocol)

  let heldTokenHourData = updateAndReturnTokenHourDataForMarginEvent(heldToken, event)
  let owedTokenHourData = updateAndReturnTokenHourDataForMarginEvent(owedToken, event)
  let heldTokenDayData = updateAndReturnTokenDayDataForMarginEvent(heldToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForMarginEvent(owedToken, event)

  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForVaporization(dolomiteDayData, heldTokenDayData, heldTokenHourData, heldToken, vaporization as Vaporization)
  updateTimeDataForVaporization(dolomiteDayData, owedTokenDayData, owedTokenHourData, owedToken, vaporization as Vaporization)

  if (vaporMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, vaporMarginAccount)
    if (marginPosition.status == MarginPositionStatus.Liquidated) {
      // when an account is vaporized, the vaporHeldAmount is zero, so it's not updated
      marginPosition.owedAmountPar = convertStructToDecimal(vaporOwedNewParStruct, owedToken.decimals)
      marginPosition.save()
    }
  }

  vaporMarginAccount.save()
  solidMarginAccount.save()
  vaporization.save()
  transaction.save()
}

export function handleMarginPositionOpen(event: MarginPositionOpenEvent): void {
  let marginAccount = getOrCreateMarginAccount(event.params.user, event.params.accountIndex, event.block)
  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  let positionChangeEvent = new PositionChangeEvent(
    event.params.user,
    event.params.accountIndex,
    Token.load(event.params.inputToken.toHexString()) as Token,
    Token.load(event.params.outputToken.toHexString()) as Token,
    Token.load(event.params.depositToken.toHexString()) as Token,
    event.params.inputBalanceUpdate.deltaWei.value,
    event.params.outputBalanceUpdate.deltaWei.value,
    event.params.marginDepositUpdate.deltaWei.value,
    true,
    event.block.number,
    event.block.timestamp,
    event.transaction.hash
  )
  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.marketId.toString()) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.marketId.toString()) as InterestIndex

  updateMarginPositionForTrade(marginPosition, positionChangeEvent, marginProtocol, inputBalanceUpdate, outputBalanceUpdate, inputIndex, outputIndex)
  marginPosition.save()
}

export function handleMarginPositionClose(event: MarginPositionCloseEvent): void {
  let marginAccount = getOrCreateMarginAccount(event.params.user, event.params.accountIndex, event.block)
  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  let positionChangeEvent = new PositionChangeEvent(
    event.params.user,
    event.params.accountIndex,
    Token.load(event.params.inputToken.toHexString()) as Token,
    Token.load(event.params.outputToken.toHexString()) as Token,
    Token.load(event.params.withdrawalToken.toHexString()) as Token,
    event.params.inputBalanceUpdate.deltaWei.value,
    event.params.outputBalanceUpdate.deltaWei.value,
    event.params.marginWithdrawalUpdate.deltaWei.value,
    false,
    event.block.number,
    event.block.timestamp,
    event.transaction.hash
  )
  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.marketId.toString()) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.marketId.toString()) as InterestIndex

  updateMarginPositionForTrade(marginPosition, positionChangeEvent, marginProtocol, inputBalanceUpdate, outputBalanceUpdate, inputIndex, outputIndex)
  marginPosition.save()
}

export function handleSetExpiry(event: ExpirySetEvent): void {
  log.info(
    'Handling expiration set for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let params = event.params
  let marginAccount = getOrCreateMarginAccount(event.params.owner, event.params.number, event.block)
  marginAccount.save()

  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  if (marginPosition.marginDeposit.notEqual(ZERO_BD) && marginPosition.status == MarginPositionStatus.Open) {
    if (params.time.equals(ZERO_BI)) {
      marginPosition.expirationTimestamp = null
    } else {
      marginPosition.expirationTimestamp = params.time
    }
    marginPosition.save()
  }

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let tokenAddress = marginProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
  let token = Token.load(tokenAddress) as Token

  let tokenValue = getOrCreateTokenValue(marginAccount, token)
  if (tokenValue.expirationTimestamp !== null && event.params.time.equals(ZERO_BI)) {
    // The user is going from having an expiration to not having one, remove
    let index = marginAccount.expirationMarketIds.indexOf(tokenValue.id)
    if (index != -1) {
      let arrayCopy = marginAccount.expirationMarketIds
      arrayCopy.splice(index, 1)
      marginAccount.expirationMarketIds = arrayCopy
    }
  } else if (tokenValue.expirationTimestamp === null && event.params.time.gt(ZERO_BI)) {
    // The user is going from having no expiration to having one, add it to the list
    marginAccount.expirationMarketIds = marginAccount.expirationMarketIds.concat([tokenValue.id])
  }
  marginAccount.hasExpiration = marginAccount.expirationMarketIds.length > 0

  tokenValue.expirationTimestamp = event.params.time.gt(ZERO_BI) ? event.params.time : null
  tokenValue.expiryAddress = event.params.time.gt(ZERO_BI) ? event.address.toHexString() : null
  tokenValue.save()
}