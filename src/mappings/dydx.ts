/* eslint-disable prefer-const */
import {
  DyDx,
  ExpirySet as ExpirySetEvent,
  LogAddMarket as AddMarketEvent,
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
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent
} from '../types/MarginTrade/DyDx'
import {
  Bundle,
  Deposit,
  DyDxSoloMargin,
  InterestIndex,
  InterestRate,
  Liquidation,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  MarketRiskInfo,
  OraclePrice,
  Token,
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
  createUserIfNecessary,
  ONE_BI,
  parToWei,
  SECONDS_IN_YEAR,
  SOLO_MARGIN_ADDRESS,
  weiToPar,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
} from './helpers'
import { getOrCreateTransaction } from './core'
import { BalanceUpdate, MarginPositionStatus, ValueStruct } from './dydx_types'
import { Address, BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import {
  updateAndReturnTokenDayDataForDyDxEvent,
  updateAndReturnTokenHourDataForDyDxEvent,
  updateDolomiteDayData,
  updateTimeDataForLiquidation,
  updateTimeDataForTrade,
  updateTimeDataForVaporization
} from './dayUpdates'
import { initializeToken } from './factory'
import { getTokenOraclePriceUSD } from './pricing'

function isMarginPositionExpired(marginPosition: MarginPosition, event: ethereum.Event): boolean {
  return marginPosition.expirationTimestamp !== null && (marginPosition.expirationTimestamp as BigInt).lt(event.block.timestamp)
}

function getOrCreateSoloMarginForDyDxCall(event: ethereum.Event): DyDxSoloMargin {
  let soloMargin = DyDxSoloMargin.load(SOLO_MARGIN_ADDRESS)
  if (soloMargin === null) {
    soloMargin = new DyDxSoloMargin(SOLO_MARGIN_ADDRESS)

    soloMargin.supplyLiquidityUSD = ZERO_BD
    soloMargin.borrowLiquidityUSD = ZERO_BD

    soloMargin.totalBorrowVolumeUSD = ZERO_BD
    soloMargin.totalLiquidationVolumeUSD = ZERO_BD
    soloMargin.totalSupplyVolumeUSD = ZERO_BD
    soloMargin.totalTradeVolumeUSD = ZERO_BD
    soloMargin.totalVaporizationVolumeUSD = ZERO_BD

    soloMargin.lastTransactionHash = ZERO_BYTES

    soloMargin.actionCount = ZERO_BI
    soloMargin.liquidationCount = ZERO_BI
    soloMargin.tradeCount = ZERO_BI
    soloMargin.transactionCount = ZERO_BI
    soloMargin.vaporizationCount = ZERO_BI
  }

  if (soloMargin.lastTransactionHash.notEqual(event.transaction.hash)) {
    soloMargin.lastTransactionHash = event.transaction.hash
    soloMargin.transactionCount = soloMargin.transactionCount.plus(ONE_BI)
  }

  soloMargin.actionCount = soloMargin.actionCount.plus(ONE_BI)
  soloMargin.save()

  return soloMargin as DyDxSoloMargin
}

export function handleMarketAdded(event: AddMarketEvent): void {
  log.info(
    'Adding market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  if (event.address.toHexString() != SOLO_MARGIN_ADDRESS) {
    log.error('Invalid SoloMargin address, found {} and {}', [event.address.toHexString(), SOLO_MARGIN_ADDRESS])
    throw new Error()
  }

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
  interestRate.borrowInterestRate = BigDecimal.fromString('0')
  interestRate.supplyInterestRate = BigDecimal.fromString('0')
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

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let riskLimits = dydxProtocol.getRiskLimits()
  let numMarkets = dydxProtocol.getNumMarkets()

  for (let i = 0; i < numMarkets.toI32(); i++) {
    let interestRate = InterestRate.load(i.toString()) as InterestRate
    let earningsRate = new BigDecimal(event.params.earningsRate.value)
    let maxEarningsRate = new BigDecimal(riskLimits.earningsRateMax)
    interestRate.supplyInterestRate = interestRate.borrowInterestRate.times(earningsRate).div(maxEarningsRate).truncate(18)
    interestRate.save()
  }
}

export function handleSetMarginPremium(event: MarginPremiumUpdateEvent): void {
  log.info(
    'Handling margin premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = dydxProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.liquidationRewardPremium = BigDecimal.fromString('0')
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

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = dydxProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.marginPremium = BigDecimal.fromString('0')
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

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = dydxProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
    marketInfo.marginPremium = BigDecimal.fromString('0')
    marketInfo.liquidationRewardPremium = BigDecimal.fromString('0')
    marketInfo.isBorrowingDisabled = false
  }
  marketInfo.isBorrowingDisabled = event.params.isClosing
  marketInfo.save()
}

export function handleOperation(event: OperationEvent): void {
  let bundle = Bundle.load('1') as Bundle
  if (bundle.priceOracleLastUpdatedBlockHash != event.block.hash.toHexString()) {
    bundle.priceOracleLastUpdatedBlockHash = event.block.hash.toHexString()

    let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
    let marketCount = dydxProtocol.getNumMarkets().toI32()
    for (let marketId = 0; marketId < marketCount; marketId++) {
      let oraclePrice = OraclePrice.load(marketId.toString()) as OraclePrice
      let token = Token.load(dydxProtocol.getMarketTokenAddress(BigInt.fromI32(marketId)).toHexString()) as Token

      let tokenAmountBI = dydxProtocol.getMarketPrice(BigInt.fromI32(marketId)).value
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

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let indexResult = dydxProtocol.getMarketCurrentIndex(event.params.market)
  index.borrowIndex = convertTokenToDecimal(indexResult.borrow, BI_18)
  index.supplyIndex = convertTokenToDecimal(indexResult.supply, BI_18)
  index.lastUpdate = event.params.index.lastUpdate
  index.save()

  let interestRatePerSecond = dydxProtocol.getMarketInterestRate(event.params.market).value
  let interestPerYearBD = new BigDecimal(interestRatePerSecond.times(SECONDS_IN_YEAR))
  let earningsRateMax = new BigDecimal(dydxProtocol.getRiskLimits().earningsRateMax)
  let earningsRate = new BigDecimal(dydxProtocol.getEarningsRate().value)

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
    tokenValue.marketId = token.marketId
    tokenValue.token = token.id
    tokenValue.valuePar = ZERO_BD
  }

  return tokenValue as MarginAccountTokenValue
}

function handleDyDxBalanceUpdateForAccount(balanceUpdate: BalanceUpdate, block: ethereum.Block): MarginAccount {
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let tokenAddress = dydxProtocol.getMarketTokenAddress(balanceUpdate.market)
  let token = Token.load(tokenAddress.toHexString())
  let tokenValue = getOrCreateTokenValue(marginAccount, token as Token)

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
  trade: Trade,
  event: ethereum.Event,
  dydxProtocol: DyDx,
  isTaker: boolean,
  makerTokenNewPar: ValueStruct,
  takerTokenNewPar: ValueStruct
): void {
  let isPositionBeingOpened = false
  if (marginPosition.owedToken === null || marginPosition.heldToken === null) {
    // the position is being opened
    isPositionBeingOpened = true
    if (!isTaker) {
      marginPosition.owedToken = trade.makerToken
      marginPosition.heldToken = trade.takerToken
    } else {
      marginPosition.owedToken = trade.takerToken
      marginPosition.heldToken = trade.makerToken
    }
  }

  let heldToken: Token = Token.load(marginPosition.heldToken as string) as Token
  let owedToken: Token = Token.load(marginPosition.owedToken as string) as Token

  const heldTokenNewPar = marginPosition.heldToken == trade.makerToken ?
    absBD(convertStructToDecimal(makerTokenNewPar, heldToken.decimals)) :
    absBD(convertStructToDecimal(takerTokenNewPar, heldToken.decimals))
  const owedTokenNewPar = marginPosition.owedToken == trade.makerToken ?
    absBD(convertStructToDecimal(makerTokenNewPar, owedToken.decimals)) :
    absBD(convertStructToDecimal(takerTokenNewPar, owedToken.decimals))

  // if the trader is the taker, the taker gets `makerToken` and spends `takerToken`, else the opposite is true
  // if the trader is the taker and is receiving owed token, the taker is repaying the loan OR
  // if the trader is the maker and is receiving owed token, the maker is repaying a loan
  let isRepayingLoan = (isTaker && trade.takerToken == marginPosition.heldToken && trade.makerToken == marginPosition.owedToken)
    || (!isTaker && trade.makerToken == marginPosition.heldToken && trade.takerToken == marginPosition.owedToken)

  let takerAmountWei = isRepayingLoan ? trade.takerTokenDeltaWei.neg() : trade.takerTokenDeltaWei
  let makerAmountWei = isRepayingLoan ? trade.makerTokenDeltaWei.neg() : trade.makerTokenDeltaWei

  let heldAmountWei = marginPosition.heldToken == trade.takerToken ? takerAmountWei : makerAmountWei
  let owedAmountWei = marginPosition.owedToken == trade.takerToken ? takerAmountWei : makerAmountWei

  if ((marginPosition.owedToken == trade.makerToken && marginPosition.heldToken == trade.takerToken) ||
    (marginPosition.owedToken == trade.takerToken && marginPosition.heldToken == trade.makerToken)) {
    marginPosition.owedAmountPar = owedTokenNewPar
    marginPosition.heldAmountPar = heldTokenNewPar

    if (isPositionBeingOpened) {
      let owedPriceUSD = getTokenOraclePriceUSD(owedToken)
      let heldPriceUSD = getTokenOraclePriceUSD(heldToken)

      marginPosition.initialOwedAmountPar = marginPosition.owedAmountPar
      marginPosition.initialOwedAmountWei = marginPosition.initialOwedAmountWei.plus(owedAmountWei)
      marginPosition.initialOwedAmountUSD = marginPosition.initialOwedAmountUSD.plus(owedAmountWei.times(owedPriceUSD).truncate(18))
      marginPosition.initialOwedPriceUSD = owedPriceUSD

      marginPosition.initialHeldAmountPar = heldTokenNewPar
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(heldAmountWei)
      marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(heldAmountWei.times(heldPriceUSD).truncate(18))
      marginPosition.initialHeldPriceUSD = heldPriceUSD
    }
  }

  if (
    (marginPosition.heldAmountPar.ge(ZERO_BD) || marginPosition.heldAmountPar.le(BigDecimal.fromString('0.000001')))
    && isMarginPositionExpired(marginPosition, event)
  ) {
    marginPosition.status = MarginPositionStatus.Expired
  }

  marginPosition.save()
}

function getOwedPriceUSD(dydxProtocol: DyDx, marginPosition: MarginPosition): BigDecimal {
  if (marginPosition.owedToken !== null) {
    let token = Token.load(marginPosition.owedToken as string) as Token
    return getTokenOraclePriceUSD(token)
  } else {
    return ZERO_BD
  }
}

export function handleDeposit(event: DepositEvent): void {
  log.info(
    'Handling deposit for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let depositID = getIDForEvent(event)
  let deposit = Deposit.load(depositID)
  if (deposit === null) {
    deposit = new Deposit(depositID)
    deposit.serialId = soloMargin.actionCount
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

  soloMargin.totalSupplyVolumeUSD = soloMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei)

  let marketIndex = InterestIndex.load(event.params.market.toString()) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStruct, marketIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  marginAccount.save()
  deposit.save()
  transaction.save()

  updateAndReturnTokenDayDataForDyDxEvent(token, event)
  updateAndReturnTokenHourDataForDyDxEvent(token, event)
}

export function handleWithdraw(event: WithdrawEvent): void {
  log.info(
    'Handling withdrawal for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let withdrawalID = getIDForEvent(event)
  let withdrawal = Withdrawal.load(withdrawalID)
  if (withdrawal === null) {
    withdrawal = new Withdrawal(withdrawalID)
    withdrawal.serialId = soloMargin.actionCount
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
  changeProtocolBalance(token, newParStruct, deltaWeiStructAbs.neg(), marketIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  updateAndReturnTokenHourDataForDyDxEvent(token, event)
  updateAndReturnTokenDayDataForDyDxEvent(token, event)
}

export function handleTransfer(event: TransferEvent): void {
  log.info(
    'Handling transfer for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.market,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign,
    token
  )
  let marginAccount1 = handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.market,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign,
    token
  )
  let marginAccount2 = handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let transferID = getIDForEvent(event)
  let transfer = Transfer.load(transferID)
  if (transfer === null) {
    transfer = new Transfer(transferID)
    transfer.serialId = soloMargin.actionCount
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
    soloMargin,
    dydxProtocol
  )
  changeProtocolBalance(
    token,
    new ValueStruct(event.params.updateTwo.newPar),
    new ValueStruct(event.params.updateTwo.deltaWei),
    marketIndex,
    isVirtualTransfer,
    soloMargin,
    dydxProtocol
  )

  if (marginAccount1.user == marginAccount2.user) {
    if (marginAccount1.accountNumber.equals(ZERO_BI) && marginAccount2.accountNumber.notEqual(ZERO_BI)) {
      let marginPosition = getOrCreateMarginPosition(event, marginAccount2)
      // The user is opening the position or transferring collateral
      if (marginPosition.status == MarginPositionStatus.Open && marginPosition.heldToken == token.id) {
        marginPosition.marginDeposit = transfer.amountDeltaWei
        marginPosition.marginDepositUSD = transfer.amountUSDDeltaWei

        marginPosition.initialHeldAmountPar = balanceUpdateTwo.valuePar
        marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(marginPosition.marginDeposit)
        marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(marginPosition.marginDepositUSD)
        marginPosition.initialHeldPriceUSD = priceUSD

        marginPosition.heldAmountPar = balanceUpdateTwo.valuePar

        marginPosition.save()
      }
    } else if (marginAccount2.accountNumber.equals(ZERO_BI) && marginAccount1.accountNumber.notEqual(ZERO_BI)) {
      let marginPosition = getOrCreateMarginPosition(event, marginAccount1)
      // The user is closing the position or removing collateral
      if (token.id == marginPosition.heldToken) {
        let oldHeldAmountPar = marginPosition.heldAmountPar
        marginPosition.heldAmountPar = balanceUpdateOne.valuePar

        if (marginPosition.heldAmountPar.le(ZERO_BD) && marginPosition.status == MarginPositionStatus.Open) {
          marginPosition.status = MarginPositionStatus.Closed
          marginPosition.closeTimestamp = event.block.timestamp

          let closeHeldAmountWei = parToWei(oldHeldAmountPar, marketIndex)
          marginPosition.closeHeldPriceUSD = priceUSD
          marginPosition.closeHeldAmountWei = closeHeldAmountWei
          marginPosition.closeHeldAmountUSD = closeHeldAmountWei.times(priceUSD).truncate(18)

          if (marginPosition.owedToken !== null) {
            let owedToken = Token.load(marginPosition.owedToken as string) as Token
            let owedTokenIndex = InterestIndex.load(owedToken.marketId.toString()) as InterestIndex
            marginPosition.closeOwedPriceUSD = getOwedPriceUSD(dydxProtocol, marginPosition)
            let closeOwedAmountWei = parToWei(marginPosition.initialOwedAmountPar.neg(), owedTokenIndex).neg()
            marginPosition.closeOwedAmountWei = closeOwedAmountWei
            marginPosition.closeOwedAmountUSD = closeOwedAmountWei.times(marginPosition.closeOwedPriceUSD as BigDecimal).truncate(18)
          }
        }
      } else if (token.id == marginPosition.owedToken) {
        marginPosition.owedAmountPar = balanceUpdateOne.valuePar.neg()
      }

      marginPosition.save()
    }
  }

  updateAndReturnTokenHourDataForDyDxEvent(token, event)
  updateAndReturnTokenDayDataForDyDxEvent(token, event)
}

export function handleBuy(event: BuyEvent): void {
  log.info(
    'Handling BUY for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString()) as Token
  let takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    makerToken
  )
  // Don't do a variable assignment here since it's overwritten below
  handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    takerToken
  )
  let marginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = soloMargin.actionCount
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

  soloMargin.totalTradeVolumeUSD = soloMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  soloMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status == MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, true, makerNewParStruct, takerNewParStruct)
      marginPosition.save()
    }
  }
}

export function handleSell(event: SellEvent): void {
  log.info(
    'Handling SELL for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString()) as Token
  let takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    makerToken
  )
  // Don't do a variable assignment here since it's overwritten below
  handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    takerToken
  )
  let marginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = soloMargin.actionCount
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

  soloMargin.totalTradeVolumeUSD = soloMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  soloMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status == MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, true, makerNewParStruct, takerNewParStruct)
      marginPosition.save()
    }
  }
}

export function handleTrade(event: TradeEvent): void {
  log.info(
    'Handling trade for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.inputMarket).toHexString()) as Token
  let makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.outputMarket).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.inputMarket,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign,
    takerToken
  )
  handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.outputMarket,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign,
    makerToken
  )
  let makerMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.inputMarket,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign,
    takerToken
  )
  handleDyDxBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.outputMarket,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign,
    makerToken
  )
  let takerMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = soloMargin.actionCount
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

  soloMargin.totalTradeVolumeUSD = soloMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)

  let dolomiteDayData = updateDolomiteDayData(event)

  let takerIndex = InterestIndex.load(event.params.inputMarket.toString()) as InterestIndex
  let makerIndex = InterestIndex.load(event.params.outputMarket.toString()) as InterestIndex
  let isVirtualTransfer = true

  let takerInputNewParStruct = new ValueStruct(event.params.takerInputUpdate.newPar)
  changeProtocolBalance(takerToken, takerInputNewParStruct, takerInputDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let takerOutputNewParStruct = new ValueStruct(event.params.takerOutputUpdate.newPar)
  changeProtocolBalance(makerToken, takerOutputNewParStruct, takerOutputDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let makerInputNewParStruct = new ValueStruct(event.params.makerInputUpdate.newPar)
  let makerInputDeltaWeiStruct = new ValueStruct(event.params.makerInputUpdate.deltaWei)
  changeProtocolBalance(makerToken, makerInputNewParStruct, makerInputDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let makerOutputNewParStruct = new ValueStruct(event.params.makerOutputUpdate.newPar)
  let makerOutputDeltaWeiStruct = new ValueStruct(event.params.makerOutputUpdate.deltaWei)
  changeProtocolBalance(takerToken, makerOutputNewParStruct, makerOutputDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let takerTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  let makerTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  let takerTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)
  let makerTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)

  updateTimeDataForTrade(dolomiteDayData, takerTokenDayData, takerTokenHourData, takerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, makerTokenDayData, makerTokenHourData, makerToken, trade as Trade)

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()
  soloMargin.save()

  if (makerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, makerMarginAccount)
    if (marginPosition.status == MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, false, makerInputNewParStruct, makerOutputNewParStruct)
      marginPosition.save()
    }
  }
  if (takerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, takerMarginAccount)
    if (marginPosition.status == MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, true, takerOutputNewParStruct, takerInputNewParStruct)
      marginPosition.save()
    }
  }
}

export function handleLiquidate(event: LiquidationEvent): void {
  log.info(
    'Handling liquidate for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dydxProtocol = DyDx.bind(event.address)
  let heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString()) as Token
  let owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.heldMarket,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.owedMarket,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign,
    owedToken
  )
  let liquidMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDyDxBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    owedToken
  )
  let solidMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let liquidationID = getIDForEvent(event)
  let liquidation = Liquidation.load(liquidationID)
  if (liquidation === null) {
    liquidation = new Liquidation(liquidationID)
    liquidation.serialId = soloMargin.actionCount
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

  let liquidationSpread = dydxProtocol.getLiquidationSpreadForPair(event.params.heldMarket, event.params.owedMarket).value
  let heldDeltaWei = event.params.solidHeldUpdate.deltaWei.value
  let heldTokenLiquidationRewardWei = heldDeltaWei.minus(heldDeltaWei.times(BI_ONE_ETH).div(liquidationSpread))
  liquidation.heldTokenLiquidationRewardWei = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)

  let liquidOwedDeltaWeiBD = convertStructToDecimal(liquidOwedDeltaWeiStruct, owedToken.decimals)
  liquidation.debtUSDLiquidated = liquidOwedDeltaWeiBD.times(owedPriceUSD).truncate(18)

  let liquidHeldDeltaWeiBD = convertStructToDecimal(liquidHeldDeltaWeiStruct, heldToken.decimals)
  liquidation.collateralUSDLiquidated = liquidHeldDeltaWeiBD.times(heldPriceUSD).truncate(18)

  let heldTokenLiquidationRewardWeiBD = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)
  liquidation.collateralUSDLiquidationReward = heldTokenLiquidationRewardWeiBD.times(heldPriceUSD).truncate(18)

  soloMargin.liquidationCount = soloMargin.liquidationCount.plus(ONE_BI)
  soloMargin.totalLiquidationVolumeUSD = soloMargin.totalLiquidationVolumeUSD.plus(liquidation.debtUSDLiquidated)
  soloMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin, dydxProtocol)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin, dydxProtocol)
  changeProtocolBalance(heldToken, liquidHeldNewParStruct, liquidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin, dydxProtocol)
  changeProtocolBalance(owedToken, liquidOwedNewParStruct, liquidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let heldTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(heldToken, event)
  let owedTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(owedToken, event)
  let heldTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(heldToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(owedToken, event)

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
      marginPosition.closeTimestamp = event.block.timestamp

      marginPosition.owedAmountPar = weiToPar(
        parToWei(marginPosition.owedAmountPar.neg(), owedIndex).plus(liquidation.borrowedTokenAmountDeltaWei),
        owedIndex,
        owedToken.decimals
      ).neg()
      marginPosition.heldAmountPar = weiToPar(
        parToWei(marginPosition.heldAmountPar, heldIndex).minus(liquidation.heldTokenAmountDeltaWei),
        owedIndex,
        heldToken.decimals
      )

      if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
        let heldPriceUSD = getTokenOraclePriceUSD(heldToken)
        let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

        let closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldIndex.supplyIndex).truncate(18)
        marginPosition.closeHeldPriceUSD = heldPriceUSD
        marginPosition.closeHeldAmountWei = closeHeldAmountWei
        marginPosition.closeHeldAmountUSD = closeHeldAmountWei.times(heldPriceUSD).truncate(18)

        let closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedIndex.borrowIndex).truncate(18)
        marginPosition.closeOwedPriceUSD = owedPriceUSD
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

  let dydxProtocol = DyDx.bind(event.address)
  let heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString()) as Token
  let owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString()) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.owedMarket,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign,
    owedToken
  )
  let vaporMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    heldToken
  )
  handleDyDxBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    owedToken
  )
  let solidMarginAccount = handleDyDxBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let transaction = getOrCreateTransaction(event)

  let vaporOwedNewParStruct = new ValueStruct(event.params.vaporOwedUpdate.newPar)
  let vaporOwedDeltaWeiStruct = new ValueStruct(event.params.vaporOwedUpdate.deltaWei)

  let solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)

  let solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)

  let vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
    vaporization.serialId = soloMargin.actionCount
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

  soloMargin.vaporizationCount = soloMargin.vaporizationCount.plus(ONE_BI)
  soloMargin.totalVaporizationVolumeUSD = soloMargin.totalVaporizationVolumeUSD.plus(vaporization.amountUSDVaporized)
  soloMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin, dydxProtocol)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin, dydxProtocol)
  changeProtocolBalance(owedToken, vaporOwedNewParStruct, vaporOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin, dydxProtocol)

  let heldTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(heldToken, event)
  let owedTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(owedToken, event)
  let heldTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(heldToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(owedToken, event)

  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForVaporization(dolomiteDayData, heldTokenDayData, heldTokenHourData, heldToken, vaporization as Vaporization)
  updateTimeDataForVaporization(dolomiteDayData, owedTokenDayData, owedTokenHourData, owedToken, vaporization as Vaporization)

  vaporMarginAccount.save()
  solidMarginAccount.save()
  vaporization.save()
  transaction.save()
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
  if (params.time.equals(ZERO_BI)) {
    marginPosition.expirationTimestamp = null
  } else {
    marginPosition.expirationTimestamp = params.time
  }
  marginPosition.save()

  let dydxProtocol = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let tokenAddress = dydxProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
  let token = Token.load(tokenAddress) as Token

  let tokenValue = getOrCreateTokenValue(marginAccount, token)
  tokenValue.expirationTimestamp = event.block.timestamp
  tokenValue.save()
}
