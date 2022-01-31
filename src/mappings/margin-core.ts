/* eslint-disable */
import {
  Address,
  BigDecimal,
  ethereum,
  log
} from '@graphprotocol/graph-ts'
import {
  DolomiteMargin as DolomiteMarginProtocol,
  LogBuy as BuyEvent,
  LogCall as CallEvent,
  LogDeposit as DepositEvent,
  LogIndexUpdate as IndexUpdateEvent,
  LogLiquidate as LiquidationEvent,
  LogOperation as OperationEvent,
  LogSell as SellEvent,
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent
} from '../types/MarginCore/DolomiteMargin'
import {
  Deposit,
  InterestIndex,
  InterestRate,
  Liquidation,
  MarginAccountTokenValue,
  MarginPosition,
  Token,
  TokenMarketIdReverseMap,
  TotalPar,
  Trade,
  Transfer,
  Vaporization,
  Withdrawal
} from '../types/schema'
import { getOrCreateTransaction } from './amm-core'
import {
  convertStructToDecimalAppliedValue,
  convertTokenToDecimal
} from './amm-helpers'
import {
  updateAndReturnTokenDayDataForMarginEvent,
  updateAndReturnTokenHourDataForMarginEvent,
  updateDolomiteDayData,
  updateTimeDataForLiquidation,
  updateTimeDataForTrade,
  updateTimeDataForVaporization
} from './day-updates'
import {
  _18_BI,
  DOLOMITE_MARGIN_ADDRESS,
  EXPIRY_ADDRESS,
  ONE_BI,
  ONE_ETH_BD,
  SECONDS_IN_YEAR,
  TEN_BI,
  ZERO_BD,
  ZERO_BI
} from './generated/constants'
import { absBD } from './helpers'
import {
  changeProtocolBalance,
  getIDForEvent,
  getLiquidationSpreadForPair,
  getOrCreateDolomiteMarginForCall,
  getOrCreateMarginAccount,
  getOrCreateMarginPosition,
  handleDolomiteMarginBalanceUpdateForAccount,
  invalidateMarginPosition,
  parToWei,
  roundHalfUp
} from './margin-helpers'
import {
  BalanceUpdate,
  MarginPositionStatus,
  ProtocolType,
  ValueStruct
} from './margin-types'
import { getTokenOraclePriceUSD } from './pricing'

// noinspection JSUnusedGlobalSymbols,JSUnusedLocalSymbols
export function handleOperation(event: OperationEvent): void {
  // do nothing as of now
}

// noinspection JSUnusedGlobalSymbols
export function handleIndexUpdate(event: IndexUpdateEvent): void {
  log.info(
    'Handling index update for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseMap.load(event.params.market.toString())!.token
  let index = InterestIndex.load(tokenAddress)
  if (index === null) {
    index = new InterestIndex(tokenAddress)
  }

  index.borrowIndex = convertTokenToDecimal(event.params.index.borrow, _18_BI)
  index.supplyIndex = convertTokenToDecimal(event.params.index.supply, _18_BI)
  index.lastUpdate = event.params.index.lastUpdate
  index.save()

  let interestRate = InterestRate.load(tokenAddress) as InterestRate
  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let interestRatePerSecond = marginProtocol.getMarketInterestRate(event.params.market).value
  let interestPerYearBD = new BigDecimal(interestRatePerSecond.times(SECONDS_IN_YEAR))
  interestRate.borrowInterestRate = interestPerYearBD.div(ONE_ETH_BD)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Core)

  let token = Token.load(tokenAddress) as Token
  let totalPar = TotalPar.load(tokenAddress) as TotalPar
  let borrowWei = absBD(parToWei(totalPar.borrowPar.neg(), index, token.decimals))
  let supplyWei = parToWei(totalPar.supplyPar, index, token.decimals)

  if (borrowWei.lt(supplyWei)) {
    // the supply interest rate is spread across the supplied balance, which is paid on the borrow amount. Therefore,
    // the interest owed must be scaled down by the supplied we vs owed wei
    interestRate.supplyInterestRate = interestRate.borrowInterestRate
      .times(dolomiteMargin.earningsRate)
      .truncate(18)
      .times(borrowWei)
      .div(supplyWei)
      .truncate(token.decimals.toI32())
  } else {
    interestRate.supplyInterestRate = interestRate.borrowInterestRate
      .times(dolomiteMargin.earningsRate)
      .truncate(18)
  }

  interestRate.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleDeposit(event: DepositEvent): void {
  log.info(
    'Handling deposit for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let token = Token.load(TokenMarketIdReverseMap.load(event.params.market.toString())!.token) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

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
  deposit.amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals)
  deposit.amountUSDDeltaWei = deposit.amountDeltaWei.times(getTokenOraclePriceUSD(token, event, ProtocolType.Core))
    .truncate(18)

  dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei)

  let marketIndex = InterestIndex.load(token.id) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(
    event,
    token,
    newParStruct,
    deltaWeiStruct,
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  marginAccount.save()
  deposit.save()
  transaction.save()

  updateAndReturnTokenHourDataForMarginEvent(token, event)
  updateAndReturnTokenDayDataForMarginEvent(token, event)
  updateDolomiteDayData(event)
}

// noinspection JSUnusedGlobalSymbols
export function handleWithdraw(event: WithdrawEvent): void {
  log.info(
    'Handling withdrawal for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let token = Token.load(TokenMarketIdReverseMap.load(event.params.market.toString())!.token) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    token
  )
  let marginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

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
  withdrawal.amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStructAbs, token.decimals)
  withdrawal.amountUSDDeltaWei = withdrawal.amountDeltaWei
    .times(getTokenOraclePriceUSD(token, event, ProtocolType.Core))
    .truncate(18)

  marginAccount.save()
  withdrawal.save()
  transaction.save()

  let marketIndex = InterestIndex.load(token.id) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(
    event,
    token,
    newParStruct,
    deltaWeiStruct,
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  updateAndReturnTokenHourDataForMarginEvent(token, event)
  updateAndReturnTokenDayDataForMarginEvent(token, event)
  updateDolomiteDayData(event)
}

// noinspection JSUnusedGlobalSymbols
export function handleTransfer(event: TransferEvent): void {
  log.info(
    'Handling transfer for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let token = Token.load(TokenMarketIdReverseMap.load(event.params.market.toString())!.token) as Token

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

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

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
  let priceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
  transfer.amountDeltaWei = convertStructToDecimalAppliedValue(amountDeltaWei.abs(), token.decimals)
  transfer.amountUSDDeltaWei = transfer.amountDeltaWei.times(priceUSD)
    .truncate(18)

  marginAccount1.save()
  marginAccount2.save()
  transfer.save()
  transaction.save()

  let marketIndex = InterestIndex.load(token.id) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    token,
    new ValueStruct(event.params.updateOne.newPar),
    new ValueStruct(event.params.updateOne.deltaWei),
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )
  changeProtocolBalance(
    event,
    token,
    new ValueStruct(event.params.updateTwo.newPar),
    new ValueStruct(event.params.updateTwo.deltaWei),
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
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
        if (token.id == marginPosition.heldToken) {
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
  updateDolomiteDayData(event)
}

// noinspection JSUnusedGlobalSymbols
export function handleBuy(event: BuyEvent): void {
  log.info(
    'Handling BUY for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let makerToken = Token.load(TokenMarketIdReverseMap.load(event.params.makerMarket.toString())!.token) as Token
  let takerToken = Token.load(TokenMarketIdReverseMap.load(event.params.takerMarket.toString())!.token) as Token

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

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
    trade.traderAddress = event.params.exchangeWrapper
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = marginAccount.id
  trade.makerMarginAccount = null
  trade.walletsConcatenated = marginAccount.user

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimalAppliedValue(takerDeltaWeiStruct.abs(), takerToken.decimals)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimalAppliedValue(makerDeltaWeiStruct.abs(), makerToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei
    .times(getTokenOraclePriceUSD(takerToken, event, ProtocolType.Core))
    .truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let makerIndex = InterestIndex.load(makerToken.id) as InterestIndex
  let takerIndex = InterestIndex.load(takerToken.id) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(
    event,
    makerToken,
    takerNewParStruct,
    takerDeltaWeiStruct,
    makerIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(
    event,
    takerToken,
    makerNewParStruct,
    makerDeltaWeiStruct,
    takerIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let inputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(takerToken, event)
  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, event, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, event, trade as Trade)

  invalidateMarginPosition(marginAccount)
}

// noinspection JSUnusedGlobalSymbols
export function handleSell(event: SellEvent): void {
  log.info(
    'Handling SELL for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let makerToken = Token.load(TokenMarketIdReverseMap.load(event.params.makerMarket.toString())!.token) as Token
  let takerToken = Token.load(TokenMarketIdReverseMap.load(event.params.takerMarket.toString())!.token) as Token

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

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
    trade.traderAddress = event.params.exchangeWrapper
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = marginAccount.id
  trade.makerMarginAccount = null
  trade.walletsConcatenated = marginAccount.user

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimalAppliedValue(takerDeltaWeiStruct.abs(), takerToken.decimals)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimalAppliedValue(makerDeltaWeiStruct.abs(), makerToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei
    .times(getTokenOraclePriceUSD(takerToken, event, ProtocolType.Core))
    .truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  marginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let makerIndex = InterestIndex.load(makerToken.id) as InterestIndex
  let takerIndex = InterestIndex.load(takerToken.id) as InterestIndex
  let isVirtualTransfer = false

  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  changeProtocolBalance(
    event,
    makerToken,
    takerNewParStruct,
    takerDeltaWeiStruct,
    makerIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  changeProtocolBalance(
    event,
    takerToken,
    makerNewParStruct,
    makerDeltaWeiStruct,
    takerIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let inputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(takerToken, event)
  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, event, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, event, trade as Trade)

  invalidateMarginPosition(marginAccount)
}

// noinspection JSUnusedGlobalSymbols
export function handleTrade(event: TradeEvent): void {
  log.info(
    'Handling trade for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let inputToken = Token.load(TokenMarketIdReverseMap.load(event.params.inputMarket.toString())!.token) as Token
  let outputToken = Token.load(TokenMarketIdReverseMap.load(event.params.outputMarket.toString())!.token) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign,
    inputToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign,
    outputToken
  )
  let makerMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign,
    inputToken
  )
  handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign,
    outputToken
  )
  let takerMarginAccount = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = dolomiteMargin.actionCount
    trade.traderAddress = event.params.autoTrader
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerMarginAccount = takerMarginAccount.id
  trade.makerMarginAccount = makerMarginAccount.id
  trade.walletsConcatenated = takerMarginAccount.user + '_' + makerMarginAccount.user

  trade.takerToken = inputToken.id
  trade.makerToken = outputToken.id

  let takerInputDeltaWeiStruct = new ValueStruct(event.params.takerInputUpdate.deltaWei)
  trade.takerTokenDeltaWei = convertStructToDecimalAppliedValue(takerInputDeltaWeiStruct.abs(), inputToken.decimals)

  let takerOutputDeltaWeiStruct = new ValueStruct(event.params.takerOutputUpdate.deltaWei)
  trade.makerTokenDeltaWei = convertStructToDecimalAppliedValue(takerOutputDeltaWeiStruct.abs(), outputToken.decimals)

  trade.amountUSD = trade.takerTokenDeltaWei
    .times(getTokenOraclePriceUSD(inputToken, event, ProtocolType.Core))
    .truncate(18)

  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.amountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()
  dolomiteMargin.save()

  let inputIndex = InterestIndex.load(inputToken.id) as InterestIndex
  let outputIndex = InterestIndex.load(outputToken.id) as InterestIndex
  let isVirtualTransfer = true

  let takerInputNewParStruct = new ValueStruct(event.params.takerInputUpdate.newPar)
  changeProtocolBalance(
    event,
    inputToken,
    takerInputNewParStruct,
    takerInputDeltaWeiStruct,
    inputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let takerOutputNewParStruct = new ValueStruct(event.params.takerOutputUpdate.newPar)
  changeProtocolBalance(
    event,
    outputToken,
    takerOutputNewParStruct,
    takerOutputDeltaWeiStruct,
    outputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let makerInputNewParStruct = new ValueStruct(event.params.makerInputUpdate.newPar)
  let makerInputDeltaWeiStruct = new ValueStruct(event.params.makerInputUpdate.deltaWei)
  changeProtocolBalance(
    event,
    inputToken,
    makerInputNewParStruct,
    makerInputDeltaWeiStruct,
    inputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let makerOutputNewParStruct = new ValueStruct(event.params.makerOutputUpdate.newPar)
  let makerOutputDeltaWeiStruct = new ValueStruct(event.params.makerOutputUpdate.deltaWei)
  changeProtocolBalance(
    event,
    outputToken,
    makerOutputNewParStruct,
    makerOutputDeltaWeiStruct,
    outputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let inputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(inputToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForMarginEvent(outputToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(inputToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForMarginEvent(outputToken, event)
  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, outputToken, event, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, inputToken, event, trade as Trade)

  // if the trade is against the expiry contract, we need to change the margin position
  if (trade.traderAddress.equals(Address.fromString(EXPIRY_ADDRESS))) {
    // the maker is
    let marginPosition = getOrCreateMarginPosition(event, makerMarginAccount)

    let heldToken = marginPosition.heldToken == outputToken.id ? outputToken : inputToken
    let owedToken = marginPosition.owedToken == outputToken.id ? outputToken : inputToken

    let heldPrice = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
    let owedPrice = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

    let liquidationSpread = getLiquidationSpreadForPair(heldToken, owedToken, dolomiteMargin)

    let expiryAge = ZERO_BI
    let expiryRampTime = dolomiteMargin.expiryRampTime
    if (expiryAge.lt(expiryRampTime)) {
      liquidationSpread = liquidationSpread.times(new BigDecimal(expiryAge))
        .div(new BigDecimal(expiryRampTime))
        .truncate(18)
    }
    let owedPriceAdj = owedPrice.times(liquidationSpread)
      .truncate(36)

    // makerToken == outputToken for taker; which means it's the inputToken for the maker
    let heldNewParStruct = marginPosition.heldToken == outputToken.id ? makerInputNewParStruct : makerOutputNewParStruct
    let owedNewParStruct = marginPosition.owedToken == outputToken.id ? makerInputNewParStruct : makerOutputNewParStruct

    // makerToken == outputToken for taker; which means it's the inputToken for the maker
    let borrowedTokenAmountDeltaWeiStruct = marginPosition.owedToken == outputToken.id
      ? makerInputDeltaWeiStruct
      : makerOutputDeltaWeiStruct

    handleLiquidatePosition(
      marginPosition,
      event,
      heldPrice,
      owedPriceAdj,
      heldToken,
      owedToken,
      marginPosition.heldToken == outputToken.id ? outputIndex : inputIndex,
      marginPosition.owedToken == outputToken.id ? outputIndex : inputIndex,
      convertStructToDecimalAppliedValue(heldNewParStruct, heldToken.decimals),
      convertStructToDecimalAppliedValue(owedNewParStruct, owedToken.decimals),
      absBD(convertStructToDecimalAppliedValue(borrowedTokenAmountDeltaWeiStruct, owedToken.decimals)),
      MarginPositionStatus.Expired
    )
  }
}

// noinspection JSUnusedGlobalSymbols
export function handleLiquidate(event: LiquidationEvent): void {
  log.info(
    'Handling liquidate for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let heldToken = Token.load(TokenMarketIdReverseMap.load(event.params.heldMarket.toString())!.token) as Token
  let owedToken = Token.load(TokenMarketIdReverseMap.load(event.params.owedMarket.toString())!.token) as Token

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

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

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
  liquidation.heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(solidHeldDeltaWeiStruct.abs(), heldToken.decimals)

  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  let solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  liquidation.borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(solidOwedDeltaWeiStruct.abs(), owedToken.decimals)

  let liquidHeldDeltaWeiStruct = new ValueStruct(event.params.liquidHeldUpdate.deltaWei)
  let liquidHeldNewParStruct = new ValueStruct(event.params.liquidHeldUpdate.newPar)

  let liquidOwedDeltaWeiStruct = new ValueStruct(event.params.liquidOwedUpdate.deltaWei)
  let liquidOwedNewParStruct = new ValueStruct(event.params.liquidOwedUpdate.newPar)

  let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
  let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

  let liquidationSpread = getLiquidationSpreadForPair(heldToken, owedToken, dolomiteMargin)

  let owedPriceAdj = owedPriceUSD.times(liquidationSpread)
    .truncate(36)

  liquidation.heldTokenLiquidationRewardWei = roundHalfUp(
    liquidation.borrowedTokenAmountDeltaWei.times(owedPriceAdj)
      .div(heldPriceUSD),
    heldToken.decimals
  )

  liquidation.borrowedTokenAmountUSD = liquidation.borrowedTokenAmountDeltaWei.times(owedPriceUSD)
    .truncate(18)

  liquidation.heldTokenAmountUSD = liquidation.heldTokenAmountDeltaWei.times(heldPriceUSD)
    .truncate(18)

  liquidation.heldTokenLiquidationRewardUSD =
    liquidation.heldTokenLiquidationRewardWei.times(heldPriceUSD)
      .truncate(18)

  dolomiteMargin.liquidationCount = dolomiteMargin.liquidationCount.plus(ONE_BI)
  dolomiteMargin.totalLiquidationVolumeUSD =
    dolomiteMargin.totalLiquidationVolumeUSD.plus(liquidation.borrowedTokenAmountUSD)
  dolomiteMargin.save()

  let heldIndex = InterestIndex.load(heldToken.id) as InterestIndex
  let owedIndex = InterestIndex.load(owedToken.id) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    heldToken,
    solidHeldNewParStruct,
    solidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  changeProtocolBalance(
    event,
    owedToken,
    solidOwedNewParStruct,
    solidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  changeProtocolBalance(
    event,
    heldToken,
    liquidHeldNewParStruct,
    liquidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )
  changeProtocolBalance(
    event,
    owedToken,
    liquidOwedNewParStruct,
    liquidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let owedTokenHourData = updateAndReturnTokenHourDataForMarginEvent(owedToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForMarginEvent(owedToken, event)
  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForLiquidation(
    dolomiteDayData,
    owedTokenDayData,
    owedTokenHourData,
    owedToken,
    event,
    liquidation as Liquidation
  )

  liquidMarginAccount.save()
  solidMarginAccount.save()
  liquidation.save()
  transaction.save()

  if (liquidMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, liquidMarginAccount)
    handleLiquidatePosition(
      marginPosition,
      event,
      heldPriceUSD,
      owedPriceAdj,
      heldToken,
      owedToken,
      heldIndex,
      owedIndex,
      convertStructToDecimalAppliedValue(liquidHeldNewParStruct, heldToken.decimals),
      convertStructToDecimalAppliedValue(liquidOwedNewParStruct, owedToken.decimals),
      liquidation.borrowedTokenAmountDeltaWei,
      MarginPositionStatus.Liquidated
    )
  }
}

// noinspection JSUnusedGlobalSymbols
export function handleVaporize(event: VaporizationEvent): void {
  log.info(
    'Handling vaporize for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let heldToken = Token.load(TokenMarketIdReverseMap.load(event.params.heldMarket.toString())!.token) as Token
  let owedToken = Token.load(TokenMarketIdReverseMap.load(event.params.owedMarket.toString())!.token) as Token

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

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

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
  vaporization.borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(borrowedDeltaWeiStruct.abs(), owedToken.decimals)

  let heldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  vaporization.heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(heldDeltaWeiStruct.abs(), heldToken.decimals)

  let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

  let vaporOwedDeltaWeiBD = convertStructToDecimalAppliedValue(vaporOwedDeltaWeiStruct, owedToken.decimals)
  vaporization.amountUSDVaporized = vaporOwedDeltaWeiBD.times(owedPriceUSD)
    .truncate(18)

  dolomiteMargin.vaporizationCount = dolomiteMargin.vaporizationCount.plus(ONE_BI)
  dolomiteMargin.totalVaporizationVolumeUSD = dolomiteMargin.totalVaporizationVolumeUSD.plus(vaporization.amountUSDVaporized)
  dolomiteMargin.save()

  let heldIndex = InterestIndex.load(heldToken.id) as InterestIndex
  let owedIndex = InterestIndex.load(owedToken.id) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    heldToken,
    solidHeldNewParStruct,
    solidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  changeProtocolBalance(
    event,
    owedToken,
    solidOwedNewParStruct,
    solidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )
  changeProtocolBalance(
    event,
    owedToken,
    vaporOwedNewParStruct,
    vaporOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  )

  let owedTokenHourData = updateAndReturnTokenHourDataForMarginEvent(owedToken, event)
  let owedTokenDayData = updateAndReturnTokenDayDataForMarginEvent(owedToken, event)
  let dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForVaporization(
    dolomiteDayData,
    owedTokenDayData,
    owedTokenHourData,
    owedToken,
    event,
    vaporization as Vaporization
  )

  if (vaporMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, vaporMarginAccount)
    if (marginPosition.status == MarginPositionStatus.Liquidated) {
      // when an account is vaporized, the vaporHeldAmount is zero, so it's not updated
      marginPosition.owedAmountPar = convertStructToDecimalAppliedValue(vaporOwedNewParStruct, owedToken.decimals)
      marginPosition.save()
    }
  }

  vaporMarginAccount.save()
  solidMarginAccount.save()
  vaporization.save()
  transaction.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleCall(event: CallEvent): void {
  log.info(
    'Handling call for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)
  let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  // This algorithm of running through all token values works because if the only action is a call action, the length
  // of the array does not change. If the length does change (new markets are added or removed), the call to
  // #changeProtocolBalance would have occurred in the other margin-core#handle function
  let tokenValuesRaw = marginAccount.get('tokenValues') // TODO fix this to get from store. check if null
  if (tokenValuesRaw === null) {
    log.warning('tokenValues is null for account {}', [marginAccount.id])
    return
  }
  let tokenValues = tokenValuesRaw.toStringArray()
  for (let i = 0; i < tokenValues.length; i++) {
    let tokenValue = MarginAccountTokenValue.load(tokenValues[i]) as MarginAccountTokenValue
    let token = Token.load(tokenValue.token) as Token
    let newPar = tokenValue.valuePar.times(new BigDecimal(TEN_BI.pow(token.decimals.toI32() as u8)))
      .truncate(0).digits
    changeProtocolBalance(
      event,
      token,
      ValueStruct.fromFields(newPar.gt(ZERO_BI), newPar),
      ValueStruct.fromFields(false, ZERO_BI),
      InterestIndex.load(tokenValue.token) as InterestIndex,
      true,
      ProtocolType.Core,
      dolomiteMargin
    )

    updateAndReturnTokenHourDataForMarginEvent(token, event)
    updateAndReturnTokenDayDataForMarginEvent(token, event)
    updateDolomiteDayData(event)
  }
}

/**
 * Handles liquidations via the liquidation action and liquidation via expiration
 */
function handleLiquidatePosition(
  marginPosition: MarginPosition,
  event: ethereum.Event,
  heldPrice: BigDecimal,
  owedPriceAdj: BigDecimal,
  heldToken: Token,
  owedToken: Token,
  heldIndex: InterestIndex,
  owedIndex: InterestIndex,
  heldNewPar: BigDecimal,
  owedNewPar: BigDecimal,
  borrowedTokenAmountDeltaWei: BigDecimal,
  status: string
): void {
  if (
    marginPosition.status == MarginPositionStatus.Open ||
    marginPosition.status == MarginPositionStatus.Liquidated ||
    marginPosition.status == MarginPositionStatus.Expired
  ) {
    marginPosition.status = status
    if (marginPosition.closeTimestamp === null) {
      marginPosition.closeTimestamp = event.block.timestamp
      marginPosition.closeTransaction = event.transaction.hash.toHexString()
    }

    let heldTokenLiquidationRewardWei = roundHalfUp(
      borrowedTokenAmountDeltaWei.times(owedPriceAdj)
        .div(heldPrice),
      heldToken.decimals
    )

    let heldTokenLiquidationRewardUSD = heldTokenLiquidationRewardWei.times(heldPrice)
      .truncate(18)

    marginPosition.heldAmountPar = heldNewPar
    marginPosition.owedAmountPar = owedNewPar

    if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
      let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
      let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

      let closeHeldAmountWei = parToWei(marginPosition.initialHeldAmountPar, heldIndex, heldToken.decimals)
      let closeOwedAmountWei = parToWei(marginPosition.initialOwedAmountPar.neg(), owedIndex, owedToken.decimals)
        .neg()

      marginPosition.closeHeldPrice = heldPriceUSD.div(owedPriceUSD)
        .truncate(18)
      marginPosition.closeHeldPriceUSD = heldPriceUSD.truncate(36)
      marginPosition.closeHeldAmountWei = closeHeldAmountWei
      marginPosition.closeHeldAmountUSD = closeHeldAmountWei.times(heldPriceUSD)
        .truncate(36)

      let closeHeldAmountSeized = marginPosition.closeHeldAmountSeized
      let closeHeldAmountSeizedUSD = marginPosition.closeHeldAmountSeizedUSD
      if (closeHeldAmountSeized !== null && closeHeldAmountSeizedUSD !== null) {
        marginPosition.closeHeldAmountSeized = closeHeldAmountSeized.plus(heldTokenLiquidationRewardWei)
        marginPosition.closeHeldAmountSeizedUSD = closeHeldAmountSeizedUSD.plus(heldTokenLiquidationRewardUSD)
      } else {
        marginPosition.closeHeldAmountSeized = heldTokenLiquidationRewardWei
        marginPosition.closeHeldAmountSeizedUSD = heldTokenLiquidationRewardUSD
      }

      marginPosition.closeOwedPrice = owedPriceUSD.div(heldPriceUSD)
        .truncate(18)
      marginPosition.closeOwedPriceUSD = owedPriceUSD.truncate(36)
      marginPosition.closeOwedAmountWei = closeOwedAmountWei
      marginPosition.closeOwedAmountUSD = closeOwedAmountWei.times(owedPriceUSD)
        .truncate(36)
    }

    marginPosition.save()
  }
}
