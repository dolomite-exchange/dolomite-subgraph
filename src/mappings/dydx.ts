/* eslint-disable prefer-const */
import {
  DyDx,
  ExpirySet as ExpirySetEvent,
  LogBuy as BuyEvent,
  LogDeposit as DepositEvent,
  LogIndexUpdate as IndexUpdateEvent,
  LogLiquidate as LiquidationEvent,
  LogSell as SellEvent,
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent
} from '../types/MarginTrade/DyDx'
import {
  Deposit,
  DyDxSoloMargin,
  InterestIndex,
  Liquidation,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  Token,
  Trade,
  Transfer,
  Vaporization,
  Withdrawal
} from '../types/schema'
import {
  BI_18,
  BI_ONE_ETH,
  bigDecimalAbs,
  changeProtocolBalance,
  convertStructToDecimal,
  convertTokenToDecimal,
  ONE_BI,
  SOLO_MARGIN_ADDRESS,
  ZERO_BD,
  ZERO_BI
} from './helpers'
import { getOrCreateTransaction } from './core'
import { BalanceUpdate, MarginPositionStatus, ValueStruct } from './dydx_types'
import { Address, BigDecimal, BigInt, EthereumBlock, EthereumEvent } from '@graphprotocol/graph-ts'
import {
  updateAndReturnTokenDayDataForDyDxEvent,
  updateAndReturnTokenHourDataForDyDxEvent,
  updateDolomiteDayData,
  updateTimeDataForLiquidation,
  updateTimeDataForTrade,
  updateTimeDataForVaporization
} from './dayUpdates'

function isMarginPositionExpired(marginPosition: MarginPosition, event: EthereumEvent): boolean {
  return marginPosition.expirationTimestamp !== null && marginPosition.expirationTimestamp.lt(event.block.timestamp)
}

export function handleCallToDyDx(): DyDxSoloMargin {
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

    soloMargin.liquidationCount = ZERO_BI
    soloMargin.tradeCount = ZERO_BI
    soloMargin.transactionCount = ZERO_BI
    soloMargin.vaporizationCount = ZERO_BI
  }

  soloMargin.transactionCount = soloMargin.transactionCount.plus(ONE_BI)
  soloMargin.save()

  return soloMargin
}

export function handleIndexUpdate(event: IndexUpdateEvent): void {
  const id = event.params.market.toString()
  let index = InterestIndex.load(id)
  if (index === null) {
    index = new InterestIndex(id)
  }
  index.borrowIndex = convertTokenToDecimal(event.params.index.borrow, BI_18)
  index.supplyIndex = convertTokenToDecimal(event.params.index.supply, BI_18)
  index.lastUpdate = event.params.index.lastUpdate
  index.save()
}

function getOrCreateMarginAccount(owner: Address, accountNumber: BigInt, block: EthereumBlock): MarginAccount {
  const id = `${owner.toHexString()}-${accountNumber.toString()}`
  let marginAccount = MarginAccount.load(id)
  if (marginAccount === null) {
    marginAccount = new MarginAccount(id)
    marginAccount.user = owner.toHexString()
    marginAccount.accountNumber = accountNumber
    marginAccount.tokenValues = []
  }

  marginAccount.lastUpdatedBlockNumber = block.number
  marginAccount.lastUpdatedTimestamp = block.timestamp

  return marginAccount
}

function getOrCreateTokenValue(
  marginAccount: MarginAccount,
  token: Token
): MarginAccountTokenValue {
  const id = `${marginAccount.user}-${marginAccount.accountNumber.toString()}-${token.marketId.toString()}`
  let tokenValue = MarginAccountTokenValue.load(id)
  if (tokenValue === null) {
    tokenValue = new MarginAccountTokenValue(id)
    tokenValue.marginAccount = marginAccount.id
    tokenValue.marketId = token.marketId
    tokenValue.token = token.id
    tokenValue.valuePar = ZERO_BD
  }

  return tokenValue
}

function handleDyDxBalanceUpdate(balanceUpdate: BalanceUpdate, block: EthereumBlock): void {
  const marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)

  const dydx = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  const tokenAddress = dydx.getMarketTokenAddress(balanceUpdate.market)
  const token = Token.load(tokenAddress.toHexString())
  const tokenValue = getOrCreateTokenValue(marginAccount, token)

  tokenValue.valuePar = balanceUpdate.valuePar

  tokenValue.save()
  marginAccount.save()
}

function getIDForEvent(event: EthereumEvent): string {
  return `${event.transaction.hash.toHexString()}-${event.logIndex.toString()}`
}

function getIDForTokenValue(marginAccount: MarginAccount, marketId: BigInt): string {
  return `${marginAccount.user}-${marginAccount.accountNumber.toString()}-${marketId.toString()}`
}

function updateMarginAccountForEventAndSaveTokenValue(
  marginAccount: MarginAccount,
  event: EthereumEvent,
  marketId: BigInt,
  newPar: ValueStruct,
  token: Token
): void {
  marginAccount.lastUpdatedBlockNumber = event.block.number
  marginAccount.lastUpdatedTimestamp = event.block.timestamp

  const tokenValueID = getIDForTokenValue(marginAccount, marketId)
  let tokenValue = MarginAccountTokenValue.load(tokenValueID)
  if (tokenValue === null) {
    tokenValue = new MarginAccountTokenValue(tokenValueID)
    tokenValue.marginAccount = marginAccount.id
    tokenValue.marketId = marketId
  }

  tokenValue.valuePar = convertStructToDecimal(newPar, token.decimals)
  tokenValue.save()
}

function getOrCreateMarginPosition(event: EthereumEvent, user: MarginAccount): MarginPosition {
  let marginPosition = MarginPosition.load(user.id)
  if (marginPosition === null) {
    marginPosition = new MarginPosition(user.id)
    marginPosition.openTimestamp = event.block.timestamp

    marginPosition.marginDeposit = ZERO_BD
    marginPosition.marginDepositUSD = ZERO_BD

    marginPosition.initialHeldAmountPar = ZERO_BD
    marginPosition.initialHeldAmountWei = ZERO_BD
    marginPosition.initialHeldAmountUSD = ZERO_BD
    marginPosition.initialHeldPriceUSD = ZERO_BD
    marginPosition.heldAmount = ZERO_BD

    marginPosition.owedAmount = ZERO_BD
    marginPosition.initialOwedAmountPar = ZERO_BD
    marginPosition.initialOwedAmountWei = ZERO_BD
    marginPosition.initialOwedAmountUSD = ZERO_BD
    marginPosition.initialOwedPriceUSD = ZERO_BD
  }

  return marginPosition
}

function getTokenPriceUSD(token: Token, dydx: DyDx): BigDecimal {
  const value = dydx.getMarketPrice(token.marketId).value
  return convertTokenToDecimal(value.times(BigInt.fromI32(10).pow(token.decimals)), BigInt.fromI32(36))
}

function updateMarginPositionForTrade(
  marginPosition: MarginPosition,
  trade: Trade,
  event: EthereumEvent,
  dydx: DyDx,
  isTaker: boolean,
  makerTokenIndex: InterestIndex,
  takerTokenIndex: InterestIndex
): void {
  if (marginPosition.owedToken === null || marginPosition.heldToken === null) {
    // the position is being opened
    marginPosition.owedToken = trade.makerToken
    marginPosition.heldToken = trade.takerToken
  }

  const makerToken = Token.load(trade.makerToken)
  const takerToken = Token.load(trade.takerToken)

  // if the trader is the taker, the taker gets `makerToken` and spends `takerToken`, else the opposite is true
  // if the trader is the taker and is receiving owed token, the taker is repaying the loan OR
  // if the trader is the maker and is receiving owed token, the maker is repaying a loan
  const isRepayingLoan = (isTaker && trade.takerToken === marginPosition.heldToken) || (!isTaker && trade.makerToken === marginPosition.heldToken)

  const takerAmount = isRepayingLoan ? trade.takerTokenDeltaWei.neg() : trade.takerTokenDeltaWei
  const makerAmount = isRepayingLoan ? trade.makerTokenDeltaWei.neg() : trade.makerTokenDeltaWei

  if (marginPosition.owedToken === trade.makerToken) {
    const owedPriceUSD = getTokenPriceUSD(makerToken, dydx)
    const heldPriceUSD = getTokenPriceUSD(takerToken, dydx)

    marginPosition.owedAmount = marginPosition.owedAmount.plus(makerAmount)
    marginPosition.heldAmount = marginPosition.heldAmount.plus(takerAmount)

    if (makerAmount.gt(ZERO_BD)) {
      // The user is initially opening the position if they are sizing up the trade
      marginPosition.initialOwedAmountPar = marginPosition.initialOwedAmountPar.plus(makerAmount.div(makerTokenIndex.borrowIndex))
      marginPosition.initialOwedAmountWei = marginPosition.initialOwedAmountWei.plus(makerAmount)
      marginPosition.initialOwedAmountUSD = marginPosition.initialOwedAmountUSD.plus(makerAmount.times(owedPriceUSD))
      marginPosition.initialOwedPriceUSD = owedPriceUSD

      marginPosition.initialHeldAmountPar = marginPosition.initialHeldAmountPar.plus(takerAmount.div(takerTokenIndex.supplyIndex))
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(takerAmount)
      marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(takerAmount.times(heldPriceUSD))
      marginPosition.initialHeldPriceUSD = heldPriceUSD
    }
  } else if (marginPosition.heldToken == trade.makerToken) {
    const owedPriceUSD = getTokenPriceUSD(takerToken, dydx)
    const heldPriceUSD = getTokenPriceUSD(makerToken, dydx)

    marginPosition.owedAmount = marginPosition.owedAmount.plus(takerAmount)
    marginPosition.heldAmount = marginPosition.heldAmount.plus(makerAmount)

    if (takerAmount.gt(ZERO_BD)) {
      // The user is initially opening the position if they are sizing up the trade
      marginPosition.initialOwedAmountPar = marginPosition.initialOwedAmountPar.plus(takerAmount.div(takerTokenIndex.borrowIndex))
      marginPosition.initialOwedAmountWei = marginPosition.initialOwedAmountWei.plus(takerAmount)
      marginPosition.initialOwedAmountUSD = marginPosition.initialOwedAmountUSD.plus(takerAmount.times(owedPriceUSD))
      marginPosition.initialOwedPriceUSD = owedPriceUSD

      marginPosition.initialHeldAmountPar = marginPosition.initialHeldAmountPar.plus(takerAmount.div(takerTokenIndex.supplyIndex))
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(takerAmount)
      marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(takerAmount.times(heldPriceUSD))
      marginPosition.initialHeldPriceUSD = heldPriceUSD
    }
  }

  if (marginPosition.heldAmount.equals(ZERO_BD) && isMarginPositionExpired(marginPosition, event)) {
    marginPosition.status = MarginPositionStatus.Expired
  }

  marginPosition.save()
}

function getOwedPriceUSD(dydxProtocol: DyDx, marginPosition: MarginPosition): BigDecimal {
  if (marginPosition.owedToken !== null) {
    return getTokenPriceUSD(Token.load(marginPosition.owedToken), dydxProtocol)
  } else {
    return ZERO_BD
  }
}

export function handleDeposit(event: DepositEvent): void {
  const balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)

  const transaction = getOrCreateTransaction(event)

  const marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  const dydxProtocol = DyDx.bind(event.address)
  const token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString())
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.market,
    new ValueStruct(event.params.update.newPar),
    token
  )

  const depositID = getIDForEvent(event)
  let deposit = Deposit.load(depositID)
  if (deposit === null) {
    deposit = new Deposit(depositID)
  }

  deposit.transaction = transaction.id
  deposit.logIndex = event.logIndex
  deposit.account = marginAccount.id
  deposit.token = token.id
  deposit.from = event.params.from
  deposit.amountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.update.deltaWei), token.decimals)
  const priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  const deltaWeiUSD = ValueStruct.fromFields(
    event.params.update.deltaWei.sign,
    event.params.update.deltaWei.value.times(priceUSD.value)
  )
  deposit.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  deposit.save()
  transaction.save()
}

export function handleWithdraw(event: WithdrawEvent): void {
  const balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)

  const transaction = getOrCreateTransaction(event)

  const marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  const dydxProtocol = DyDx.bind(event.address)
  const token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString())
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.market,
    new ValueStruct(event.params.update.newPar),
    token
  )

  const depositID = getIDForEvent(event)
  let withdrawal = Withdrawal.load(depositID)
  if (withdrawal === null) {
    withdrawal = new Withdrawal(depositID)
  }

  const deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  const newParStruct = new ValueStruct(event.params.update.newPar)

  withdrawal.transaction = transaction.id
  withdrawal.logIndex = event.logIndex
  withdrawal.account = marginAccount.id
  withdrawal.token = token.id
  withdrawal.to = event.params.to
  withdrawal.amountDeltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)
  const priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  const deltaWeiUSD = ValueStruct.fromFields(
    event.params.update.deltaWei.sign,
    event.params.update.deltaWei.value.times(priceUSD.value)
  )
  withdrawal.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  withdrawal.save()
  transaction.save()

  updateDolomiteDayData(event)

  const market = InterestIndex.load(event.params.market.toString())
  const isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStruct, market, isVirtualTransfer)

  updateAndReturnTokenHourDataForDyDxEvent(token, event)
  updateAndReturnTokenDayDataForDyDxEvent(token, event)
}

export function handleTransfer(event: TransferEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.market,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.market,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString())

  const marginAccount1 = getOrCreateMarginAccount(event.params.accountOneOwner, event.params.accountOneNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount1,
    event,
    event.params.market,
    new ValueStruct(event.params.updateOne.newPar),
    token
  )

  const marginAccount2 = getOrCreateMarginAccount(event.params.accountTwoOwner, event.params.accountTwoNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount2,
    event,
    event.params.market,
    new ValueStruct(event.params.updateTwo.newPar),
    token
  )

  const transferID = getIDForEvent(event)
  let transfer = Transfer.load(transferID)
  if (transfer === null) {
    transfer = new Transfer(transferID)
  }

  transfer.transaction = transaction.id
  transfer.logIndex = event.logIndex
  transfer.fromAccount = event.params.updateOne.deltaWei.sign ? marginAccount2.id : marginAccount1.id
  transfer.toAccount = event.params.updateOne.deltaWei.sign ? marginAccount1.id : marginAccount2.id
  transfer.token = token.id

  const amountDeltaWeiAbs = new ValueStruct(event.params.updateOne.deltaWei).abs()
  transfer.amountDeltaWei = convertStructToDecimal(amountDeltaWeiAbs, token.decimals)
  const priceUSDStruct = dydxProtocol.getMarketPrice(event.params.market)
  const priceUSD = convertTokenToDecimal(priceUSDStruct.value.times(BigInt.fromI32(10).pow(token.decimals)), BigInt.fromI32(36))
  const deltaWeiUSD = ValueStruct.fromFields(
    amountDeltaWeiAbs.sign,
    amountDeltaWeiAbs.value.times(priceUSDStruct.value)
  )
  transfer.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount1.save()
  marginAccount2.save()
  transfer.save()
  transaction.save()

  const tokenIndex = InterestIndex.load(token.marketId.toString())

  if (marginAccount1.user === marginAccount2.user) {
    const marginPosition = getOrCreateMarginPosition(event, marginAccount2)
    if (marginAccount1.accountNumber.equals(ZERO_BI) && marginAccount2.accountNumber.notEqual(ZERO_BI)) {
      // The user is opening the position or transferring collateral
      if (marginPosition.status === null) {
        marginPosition.status = MarginPositionStatus.Open

        marginPosition.heldToken = token.id

        marginPosition.marginDeposit = transfer.amountDeltaWei
        marginPosition.marginDepositUSD = transfer.amountUSDDeltaWei

        marginPosition.initialHeldAmountPar = marginPosition.initialHeldAmountPar.plus(marginPosition.marginDeposit.div(tokenIndex.supplyIndex))
        marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(marginPosition.marginDeposit)
        marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(marginPosition.marginDepositUSD)
        marginPosition.initialHeldPriceUSD = priceUSD
      }

      marginPosition.heldAmount = marginPosition.heldAmount.plus(transfer.amountDeltaWei)

      marginPosition.save()
    } else if (marginAccount2.accountNumber.equals(ZERO_BI) && marginAccount1.accountNumber.notEqual(ZERO_BI)) {
      // The user is closing the position or removing collateral
      if (token.id === marginPosition.heldToken) {
        const owedToken = Token.load(marginPosition.owedToken)
        const owedTokenIndex = InterestIndex.load(owedToken?.id)

        marginPosition.heldAmount = marginPosition.heldAmount.minus(transfer.amountDeltaWei)

        if (marginPosition.heldAmount.le(ZERO_BD) && marginPosition.status === MarginPositionStatus.Open) {
          marginPosition.status = MarginPositionStatus.Closed
          marginPosition.closeTimestamp = event.block.timestamp

          marginPosition.closeHeldPriceUSD = priceUSD
          marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(tokenIndex.supplyIndex)
          marginPosition.closeHeldAmountUSD = marginPosition.closeHeldAmountWei.times(priceUSD)

          marginPosition.closeOwedPriceUSD = getOwedPriceUSD(dydxProtocol, marginPosition)
          marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex?.borrowIndex)
          marginPosition.closeOwedAmountUSD = marginPosition.closeOwedAmountWei.times(marginPosition.closeOwedPriceUSD)
        }
      } else if (token.id === marginPosition.owedToken) {
        marginPosition.owedAmount = marginPosition.owedAmount.minus(transfer.amountDeltaWei)
      }

      marginPosition.save()
    }
  }
}

export function handleBuy(event: BuyEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString())
  const takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString())

  const marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.makerMarket,
    new ValueStruct(event.params.makerUpdate.newPar),
    makerToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.takerMarket,
    new ValueStruct(event.params.takerUpdate.newPar),
    takerToken
  )

  const tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex
  trade.takerAccount = marginAccount.id
  trade.makerAccount = null
  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  const takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  const takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerNewParStruct.abs(), takerToken.decimals)

  const makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  const makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  const priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  trade.save()
  transaction.save()

  const dolomiteDayData = updateDolomiteDayData(event)

  const makerIndex = InterestIndex.load(event.params.makerMarket.toString())
  const takerIndex = InterestIndex.load(event.params.takerMarket.toString())
  const isVirtualTransfer = false
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer)

  const inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  const outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  const inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  const outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    const marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade, event, dydxProtocol, true, makerIndex, takerIndex)
      marginPosition.save()
    }
  }
}

export function handleSell(event: SellEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString())
  const takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString())

  const marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.makerMarket,
    new ValueStruct(event.params.makerUpdate.newPar),
    makerToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.takerMarket,
    new ValueStruct(event.params.takerUpdate.newPar),
    takerToken
  )

  const tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex
  trade.takerAccount = marginAccount.id
  trade.makerAccount = null
  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  const takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  const takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)

  const makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  const makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerDeltaWeiStruct.abs(), takerToken.decimals)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  const priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  trade.save()
  transaction.save()

  const dolomiteDayData = updateDolomiteDayData(event)

  const makerIndex = InterestIndex.load(event.params.makerMarket.toString())
  const takerIndex = InterestIndex.load(event.params.takerMarket.toString())
  const isVirtualTransfer = false
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer)

  const inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  const outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  const inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  const outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    const marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade, event, dydxProtocol, true, makerIndex, takerIndex)
      marginPosition.save()
    }
  }
}

export function handleTrade(event: TradeEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.inputMarket,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.outputMarket,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const balanceUpdateThree = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.inputMarket,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  const balanceUpdateFour = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.outputMarket,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateFour, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const inputToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.inputMarket).toHexString())
  const outputToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.outputMarket).toHexString())

  const takerMarginAccount = getOrCreateMarginAccount(event.params.takerAccountOwner, event.params.takerAccountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    takerMarginAccount,
    event,
    event.params.inputMarket,
    new ValueStruct(event.params.takerInputUpdate.newPar),
    outputToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    takerMarginAccount,
    event,
    event.params.outputMarket,
    new ValueStruct(event.params.takerOutputUpdate.newPar),
    inputToken
  )

  const makerMarginAccount = getOrCreateMarginAccount(event.params.makerAccountOwner, event.params.makerAccountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    makerMarginAccount,
    event,
    event.params.inputMarket,
    new ValueStruct(event.params.makerInputUpdate.newPar),
    inputToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    makerMarginAccount,
    event,
    event.params.outputMarket,
    new ValueStruct(event.params.makerOutputUpdate.newPar),
    outputToken
  )

  const tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex
  trade.takerAccount = takerMarginAccount.id
  trade.makerAccount = makerMarginAccount.id
  trade.takerToken = outputToken.id
  trade.makerToken = inputToken.id

  const takerInputDeltaWeiStruct = new ValueStruct(event.params.takerInputUpdate.deltaWei)
  const takerInputNewParStruct = new ValueStruct(event.params.takerInputUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerInputDeltaWeiStruct.abs(), outputToken.decimals)

  const takerOutputDeltaWeiStruct = new ValueStruct(event.params.takerOutputUpdate.deltaWei)
  const takerOutputNewParStruct = new ValueStruct(event.params.takerOutputUpdate.newPar)
  trade.makerTokenDeltaWei = convertStructToDecimal(takerOutputDeltaWeiStruct.abs(), inputToken.decimals)

  const makerInputDeltaWeiStruct = new ValueStruct(event.params.makerInputUpdate.deltaWei)
  const makerInputNewParStruct = new ValueStruct(event.params.makerInputUpdate.newPar)

  const makerOutputDeltaWeiStruct = new ValueStruct(event.params.makerOutputUpdate.deltaWei)
  const makerOutputNewParStruct = new ValueStruct(event.params.makerOutputUpdate.newPar)

  const priceUSD = dydxProtocol.getMarketPrice(event.params.outputMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerOutputUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const soloMargin = DyDxSoloMargin.load(SOLO_MARGIN_ADDRESS)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)
  soloMargin.save()

  const dolomiteDayData = updateDolomiteDayData(event)

  const inputIndex = InterestIndex.load(event.params.inputMarket.toString())
  const outputIndex = InterestIndex.load(event.params.outputMarket.toString())
  const isVirtualTransfer = true
  changeProtocolBalance(inputToken, takerInputNewParStruct, takerInputDeltaWeiStruct, inputIndex, isVirtualTransfer)
  changeProtocolBalance(outputToken, takerOutputNewParStruct, takerOutputDeltaWeiStruct, outputIndex, isVirtualTransfer)
  changeProtocolBalance(inputToken, makerInputNewParStruct, makerInputDeltaWeiStruct, inputIndex, isVirtualTransfer)
  changeProtocolBalance(outputToken, makerOutputNewParStruct, makerOutputDeltaWeiStruct, outputIndex, isVirtualTransfer)

  const inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(inputToken, event)
  const outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(outputToken, event)
  const inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(inputToken, event)
  const outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(outputToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, inputToken, trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, outputToken, trade)

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()

  if (makerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    const marginPosition = getOrCreateMarginPosition(event, makerMarginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade, event, dydxProtocol, false, outputIndex, inputIndex)
      marginPosition.save()
    }
  }
  if (takerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    const marginPosition = getOrCreateMarginPosition(event, takerMarginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade, event, dydxProtocol, false, inputIndex, outputIndex)
      marginPosition.save()
    }
  }
}

export function handleLiquidate(event: LiquidationEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.heldMarket,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.owedMarket,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  const balanceUpdateFour = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateFour, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString())
  const owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString())

  const liquidMarginAccount = getOrCreateMarginAccount(event.params.liquidAccountOwner, event.params.liquidAccountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    liquidMarginAccount,
    event,
    event.params.heldMarket,
    new ValueStruct(event.params.liquidHeldUpdate.newPar),
    heldToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    liquidMarginAccount,
    event,
    event.params.owedMarket,
    new ValueStruct(event.params.liquidOwedUpdate.newPar),
    owedToken
  )

  const solidMarginAccount = getOrCreateMarginAccount(event.params.solidAccountOwner, event.params.solidAccountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.heldMarket,
    new ValueStruct(event.params.solidHeldUpdate.newPar),
    heldToken
  )
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.owedMarket,
    new ValueStruct(event.params.solidOwedUpdate.newPar),
    owedToken
  )

  const liquidationID = getIDForEvent(event)
  let liquidation = Liquidation.load(liquidationID)
  if (liquidation === null) {
    liquidation = new Liquidation(liquidationID)
  }

  liquidation.transaction = transaction.id
  liquidation.logIndex = event.logIndex
  liquidation.liquidAccount = liquidMarginAccount.id
  liquidation.solidAccount = solidMarginAccount.id
  liquidation.heldToken = heldToken.id
  liquidation.borrowedToken = owedToken.id

  const solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  const solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  liquidation.solidHeldTokenAmountDeltaWei = convertStructToDecimal(solidHeldDeltaWeiStruct, heldToken.decimals)

  const solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  const solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  liquidation.solidBorrowedTokenAmountDeltaWei = convertStructToDecimal(solidOwedDeltaWeiStruct, owedToken.decimals)

  const liquidHeldDeltaWeiStruct = new ValueStruct(event.params.liquidHeldUpdate.deltaWei)
  const liquidHeldNewParStruct = new ValueStruct(event.params.liquidHeldUpdate.newPar)
  liquidation.liquidHeldTokenAmountDeltaWei = convertStructToDecimal(liquidHeldDeltaWeiStruct, heldToken.decimals)

  const liquidOwedDeltaWeiStruct = new ValueStruct(event.params.liquidOwedUpdate.deltaWei)
  const liquidOwedNewParStruct = new ValueStruct(event.params.liquidOwedUpdate.newPar)
  liquidation.liquidBorrowedTokenAmountDeltaWei = convertStructToDecimal(liquidOwedDeltaWeiStruct, owedToken.decimals)

  const heldPriceUSD = dydxProtocol.getMarketPrice(event.params.heldMarket).value

  const liquidationSpread = dydxProtocol.getLiquidationSpreadForPair(event.params.heldMarket, event.params.owedMarket).value
  // const owedPricePlusLiquidationSpread = owedPriceUSD.plus(owedPriceUSD.times(liquidationSpread).div(BI_ONE_ETH))
  const heldDeltaWei = event.params.solidHeldUpdate.deltaWei.value
  const heldTokenLiquidationRewardWei = heldDeltaWei.minus(heldDeltaWei.times(BI_ONE_ETH).div(liquidationSpread))
  liquidation.heldTokenLiquidationRewardWei = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)

  const heldDeltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.liquidHeldUpdate.deltaWei.value.abs().times(heldPriceUSD)
  )
  liquidation.collateralUSDLiquidated = convertStructToDecimal(heldDeltaWeiUSD, BigInt.fromI32(36))

  const liquidationRewardUSD = ValueStruct.fromFields(
    true,
    heldTokenLiquidationRewardWei.times(heldPriceUSD)
  )
  liquidation.collateralUSDLiquidationReward = convertStructToDecimal(liquidationRewardUSD, BigInt.fromI32(36))

  const soloMargin = DyDxSoloMargin.load(SOLO_MARGIN_ADDRESS)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)
  soloMargin.save()

  const heldIndex = InterestIndex.load(event.params.heldMarket.toString())
  const owedIndex = InterestIndex.load(event.params.owedMarket.toString())
  const isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer)
  changeProtocolBalance(heldToken, liquidHeldNewParStruct, liquidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer)
  changeProtocolBalance(owedToken, liquidOwedNewParStruct, liquidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer)

  const heldTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(heldToken, event)
  const owedTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(owedToken, event)
  const heldTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(heldToken, event)
  const owedTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(owedToken, event)

  const dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForLiquidation(dolomiteDayData, heldTokenDayData, heldTokenHourData, heldToken, liquidation)
  updateTimeDataForLiquidation(dolomiteDayData, owedTokenDayData, owedTokenHourData, owedToken, liquidation)

  liquidMarginAccount.save()
  solidMarginAccount.save()
  liquidation.save()
  transaction.save()

  if (liquidMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    const marginPosition = getOrCreateMarginPosition(event, liquidMarginAccount)
    if (marginPosition.status === MarginPositionStatus.Open || marginPosition.status === MarginPositionStatus.Liquidated) {
      marginPosition.status = MarginPositionStatus.Liquidated
      marginPosition.closeTimestamp = event.block.timestamp

      marginPosition.owedAmount = marginPosition.owedAmount.minus(bigDecimalAbs(liquidation.liquidBorrowedTokenAmountDeltaWei))
      marginPosition.heldAmount = marginPosition.heldAmount.minus(bigDecimalAbs(liquidation.liquidHeldTokenAmountDeltaWei))

      if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
        const heldPriceUSD = getTokenPriceUSD(heldToken, dydxProtocol)
        const owedPriceUSD = getTokenPriceUSD(owedToken, dydxProtocol)

        marginPosition.closeHeldPriceUSD = heldPriceUSD
        marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldIndex.supplyIndex)
        marginPosition.closeHeldAmountUSD = marginPosition.closeHeldAmountWei.times(heldPriceUSD)

        marginPosition.closeOwedPriceUSD = owedPriceUSD
        marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedIndex.borrowIndex)
        marginPosition.closeOwedAmountUSD = marginPosition.closeOwedAmountWei.times(owedPriceUSD)
      }

      marginPosition.save()
    }
  }
}

export function handleVaporize(event: VaporizationEvent): void {
  const balanceUpdateOne = new BalanceUpdate(
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.owedMarket,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  const balanceUpdateTwo = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  const balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  const transaction = getOrCreateTransaction(event)

  const dydxProtocol = DyDx.bind(event.address)
  const heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString())
  const owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString())

  const vaporMarginAccount = getOrCreateMarginAccount(event.params.vaporAccountOwner, event.params.vaporAccountNumber, event.block)
  const vaporOwedNewParStruct = new ValueStruct(event.params.vaporOwedUpdate.newPar)
  const vaporOwedDeltaWeiStruct = new ValueStruct(event.params.vaporOwedUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    vaporMarginAccount,
    event,
    event.params.owedMarket,
    vaporOwedNewParStruct,
    owedToken
  )

  const solidMarginAccount = getOrCreateMarginAccount(event.params.solidAccountOwner, event.params.solidAccountNumber, event.block)

  const solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  const solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.heldMarket,
    solidHeldNewParStruct,
    heldToken
  )

  const solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  const solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.owedMarket,
    solidOwedNewParStruct,
    owedToken
  )

  const vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
  }

  vaporization.transaction = transaction.id
  vaporization.logIndex = event.logIndex
  vaporization.vaporAccount = vaporMarginAccount.id
  vaporization.solidAccount = solidMarginAccount.id
  vaporization.heldToken = heldToken.id
  vaporization.borrowedToken = owedToken.id

  vaporization.solidBorrowedTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.solidOwedUpdate.deltaWei), owedToken.decimals)
  vaporization.solidHeldTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.solidHeldUpdate.deltaWei), heldToken.decimals)

  vaporization.vaporBorrowedTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.vaporOwedUpdate.deltaWei), owedToken.decimals)

  const owedPriceUSD = dydxProtocol.getMarketPrice(event.params.owedMarket).value

  vaporization.amountUSDVaporized = convertTokenToDecimal(owedPriceUSD.times(event.params.vaporOwedUpdate.deltaWei.value), BigInt.fromI32(36))

  const heldIndex = InterestIndex.load(event.params.heldMarket.toString())
  const owedIndex = InterestIndex.load(event.params.owedMarket.toString())
  const isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer)
  changeProtocolBalance(owedToken, vaporOwedNewParStruct, vaporOwedDeltaWeiStruct, owedIndex, isVirtualTransfer)

  const heldTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(heldToken, event)
  const owedTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(owedToken, event)
  const heldTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(heldToken, event)
  const owedTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(owedToken, event)

  const dolomiteDayData = updateDolomiteDayData(event)

  updateTimeDataForVaporization(dolomiteDayData, heldTokenDayData, heldTokenHourData, heldToken, vaporization)
  updateTimeDataForVaporization(dolomiteDayData, owedTokenDayData, owedTokenHourData, owedToken, vaporization)

  vaporMarginAccount.save()
  solidMarginAccount.save()
  vaporization.save()
  transaction.save()
}

export function handleSetExpiry(event: ExpirySetEvent): void {
  const params = event.params
  const marginAccount = getOrCreateMarginAccount(event.params.owner, event.params.number, event.block)
  marginAccount.save()

  const marginPosition = getOrCreateMarginPosition(event, marginAccount)
  if (params.time.equals(ZERO_BI)) {
    marginPosition.expirationTimestamp = null
  } else {
    marginPosition.expirationTimestamp = params.time
  }
  marginPosition.save()

  const dydx = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  const tokenAddress = dydx.getMarketTokenAddress(event.params.marketId).toHexString()
  const token = Token.load(tokenAddress)

  const tokenValue = getOrCreateTokenValue(marginAccount, token)
  tokenValue.expirationTimestamp = event.block.timestamp
  tokenValue.save()
}
