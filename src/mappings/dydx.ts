/* eslint-disable prefer-const */
import {
  DyDx,
  ExpirySet as ExpirySetEvent,
  LogAddMarket as AddMarketEvent,
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
  changeProtocolBalance,
  convertStructToDecimal,
  convertTokenToDecimal,
  ONE_BI,
  SOLO_MARGIN_ADDRESS,
  ZERO_BD,
  ZERO_BI,
  ZERO_BYTES
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

export function getOrCreateSoloMarginForDyDxCall(event: EthereumEvent): DyDxSoloMargin {
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
  let id = event.params.marketId.toString()
  let index = new InterestIndex(id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.save()
}

export function handleIndexUpdate(event: IndexUpdateEvent): void {
  let id = event.params.market.toString()
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
  let id = `${owner.toHexString()}-${accountNumber.toString()}`
  let marginAccount = MarginAccount.load(id)
  if (marginAccount === null) {
    marginAccount = new MarginAccount(id)
    marginAccount.user = owner.toHexString()
    marginAccount.accountNumber = accountNumber
    marginAccount.tokenValues = []
  }

  marginAccount.lastUpdatedBlockNumber = block.number
  marginAccount.lastUpdatedTimestamp = block.timestamp

  return marginAccount as MarginAccount
}

function getOrCreateTokenValue(
  marginAccount: MarginAccount,
  token: Token
): MarginAccountTokenValue {
  let id = `${marginAccount.user}-${marginAccount.accountNumber.toString()}-${token.marketId.toString()}`
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

function handleDyDxBalanceUpdate(balanceUpdate: BalanceUpdate, block: EthereumBlock): void {
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)

  let dydx = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let tokenAddress = dydx.getMarketTokenAddress(balanceUpdate.market)
  let token = Token.load(tokenAddress.toHexString())
  let tokenValue = getOrCreateTokenValue(marginAccount, token as Token)

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

  let tokenValueID = getIDForTokenValue(marginAccount, marketId)
  let tokenValue = MarginAccountTokenValue.load(tokenValueID)
  if (tokenValue === null) {
    tokenValue = new MarginAccountTokenValue(tokenValueID)
    tokenValue.marginAccount = marginAccount.id
    tokenValue.marketId = marketId
  }

  tokenValue.valuePar = convertStructToDecimal(newPar, token.decimals)
  tokenValue.save()
}

function getOrCreateMarginPosition(event: EthereumEvent, account: MarginAccount): MarginPosition {
  let marginPosition = MarginPosition.load(account.id)
  if (marginPosition === null) {
    marginPosition = new MarginPosition(account.id)
    marginPosition.account = account.id
    marginPosition.accountAddress = Address.fromString(account.user)

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

  return marginPosition as MarginPosition
}

function getTokenPriceUSD(token: Token, dydx: DyDx): BigDecimal {
  let value = dydx.getMarketPrice(token.marketId).value
  return convertTokenToDecimal(value.times(BigInt.fromI32(10).pow(token.decimals.toI32() as u8)), BigInt.fromI32(36))
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

  let makerToken = Token.load(trade.makerToken) as Token
  let takerToken = Token.load(trade.takerToken) as Token

  // if the trader is the taker, the taker gets `makerToken` and spends `takerToken`, else the opposite is true
  // if the trader is the taker and is receiving owed token, the taker is repaying the loan OR
  // if the trader is the maker and is receiving owed token, the maker is repaying a loan
  let isRepayingLoan = (isTaker && trade.takerToken === marginPosition.heldToken) || (!isTaker && trade.makerToken === marginPosition.heldToken)

  let takerAmount = isRepayingLoan ? trade.takerTokenDeltaWei.neg() : trade.takerTokenDeltaWei
  let makerAmount = isRepayingLoan ? trade.makerTokenDeltaWei.neg() : trade.makerTokenDeltaWei

  if (marginPosition.owedToken === trade.makerToken) {
    let owedPriceUSD = getTokenPriceUSD(makerToken, dydx)
    let heldPriceUSD = getTokenPriceUSD(takerToken, dydx)

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
    let owedPriceUSD = getTokenPriceUSD(takerToken, dydx)
    let heldPriceUSD = getTokenPriceUSD(makerToken, dydx)

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
    let token = Token.load(marginPosition.owedToken) as Token
    return getTokenPriceUSD(token, dydxProtocol)
  } else {
    return ZERO_BD
  }
}

export function handleDeposit(event: DepositEvent): void {
  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token
  let interestIndex = InterestIndex.load(token.id) as InterestIndex
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.market,
    new ValueStruct(event.params.update.newPar),
    token
  )

  let depositID = getIDForEvent(event)
  let deposit = Deposit.load(depositID)
  if (deposit === null) {
    deposit = new Deposit(depositID)
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let newParStruct = new ValueStruct(event.params.update.newPar)

  deposit.transaction = transaction.id
  deposit.logIndex = event.logIndex
  deposit.account = marginAccount.id
  deposit.accountAddress = Address.fromString(marginAccount.user)
  deposit.token = token.id
  deposit.from = event.params.from
  deposit.amountDeltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)
  let priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  let deltaWeiUSD = ValueStruct.fromFields(
    event.params.update.deltaWei.sign,
    event.params.update.deltaWei.value.times(priceUSD.value)
  )
  deposit.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  soloMargin.totalSupplyVolumeUSD  = soloMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei)

  let marketIndex = InterestIndex.load(event.params.market.toString()) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStruct, marketIndex, isVirtualTransfer, soloMargin)

  marginAccount.save()
  deposit.save()
  transaction.save()

  updateAndReturnTokenDayDataForDyDxEvent(token, event)
  updateAndReturnTokenHourDataForDyDxEvent(token, event)
}

export function handleWithdraw(event: WithdrawEvent): void {
  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)

  let transaction = getOrCreateTransaction(event)

  let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount,
    event,
    event.params.market,
    new ValueStruct(event.params.update.newPar),
    token
  )

  let depositID = getIDForEvent(event)
  let withdrawal = Withdrawal.load(depositID)
  if (withdrawal === null) {
    withdrawal = new Withdrawal(depositID)
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let deltaWeiStructAbs = deltaWeiStruct.abs()
  let newParStruct = new ValueStruct(event.params.update.newPar)

  withdrawal.transaction = transaction.id
  withdrawal.logIndex = event.logIndex
  withdrawal.account = marginAccount.id
  withdrawal.accountAddress = Address.fromString(marginAccount.user)
  withdrawal.token = token.id
  withdrawal.to = event.params.to
  withdrawal.amountDeltaWei = convertStructToDecimal(deltaWeiStructAbs, token.decimals)
  let priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  let deltaWeiUSD = ValueStruct.fromFields(
    event.params.update.deltaWei.sign,
    event.params.update.deltaWei.value.times(priceUSD.value)
  )
  withdrawal.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  withdrawal.save()
  transaction.save()

  updateDolomiteDayData(event)

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  let marketIndex = InterestIndex.load(event.params.market.toString()) as InterestIndex
  let isVirtualTransfer = false
  changeProtocolBalance(token, newParStruct, deltaWeiStructAbs.neg(), marketIndex, isVirtualTransfer, soloMargin)

  updateAndReturnTokenHourDataForDyDxEvent(token, event)
  updateAndReturnTokenDayDataForDyDxEvent(token, event)
}

export function handleTransfer(event: TransferEvent): void {
  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.market,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.market,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let token = Token.load(dydxProtocol.getMarketTokenAddress(event.params.market).toHexString()) as Token

  let marginAccount1 = getOrCreateMarginAccount(event.params.accountOneOwner, event.params.accountOneNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount1,
    event,
    event.params.market,
    new ValueStruct(event.params.updateOne.newPar),
    token
  )

  let marginAccount2 = getOrCreateMarginAccount(event.params.accountTwoOwner, event.params.accountTwoNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    marginAccount2,
    event,
    event.params.market,
    new ValueStruct(event.params.updateTwo.newPar),
    token
  )

  let transferID = getIDForEvent(event)
  let transfer = Transfer.load(transferID)
  if (transfer === null) {
    transfer = new Transfer(transferID)
  }

  transfer.transaction = transaction.id
  transfer.logIndex = event.logIndex

  transfer.fromAccount = event.params.updateOne.deltaWei.sign ? marginAccount2.id : marginAccount1.id
  transfer.fromAccountAddress = event.params.updateOne.deltaWei.sign ? Address.fromString(marginAccount2.user) : Address.fromString(marginAccount1.user)
  transfer.toAccount = event.params.updateOne.deltaWei.sign ? marginAccount1.id : marginAccount2.id
  transfer.toAccountAddress = event.params.updateOne.deltaWei.sign ? Address.fromString(marginAccount1.user) : Address.fromString(marginAccount2.user)

  transfer.token = token.id

  let amountDeltaWei = new ValueStruct(event.params.updateOne.deltaWei)
  let amountDeltaWeiAbs = amountDeltaWei.abs()
  transfer.amountDeltaWei = convertStructToDecimal(amountDeltaWeiAbs, token.decimals)
  let priceUSDStruct = dydxProtocol.getMarketPrice(event.params.market)
  let priceUSD = convertTokenToDecimal(priceUSDStruct.value.times(BigInt.fromI32(10).pow(token.decimals.toI32() as u8)), BigInt.fromI32(36))
  let deltaWeiUSD = ValueStruct.fromFields(
    amountDeltaWeiAbs.sign,
    amountDeltaWeiAbs.value.times(priceUSDStruct.value)
  )
  transfer.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount1.save()
  marginAccount2.save()
  transfer.save()
  transaction.save()

  let marketIndex = InterestIndex.load(token.marketId.toString()) as InterestIndex
  let isVirtualTransfer = true
  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  changeProtocolBalance(
    token,
    new ValueStruct(event.params.updateOne.newPar),
    new ValueStruct(event.params.updateOne.deltaWei),
    marketIndex,
    isVirtualTransfer,
    soloMargin,
  )
  changeProtocolBalance(
    token,
    new ValueStruct(event.params.updateTwo.newPar),
    new ValueStruct(event.params.updateTwo.deltaWei),
    marketIndex,
    isVirtualTransfer,
    soloMargin,
  )

  if (marginAccount1.user === marginAccount2.user) {
    let marginPosition = getOrCreateMarginPosition(event, marginAccount2)
    if (marginAccount1.accountNumber.equals(ZERO_BI) && marginAccount2.accountNumber.notEqual(ZERO_BI)) {
      // The user is opening the position or transferring collateral
      if (marginPosition.status === null) {
        marginPosition.status = MarginPositionStatus.Open

        marginPosition.heldToken = token.id

        marginPosition.marginDeposit = transfer.amountDeltaWei
        marginPosition.marginDepositUSD = transfer.amountUSDDeltaWei

        marginPosition.initialHeldAmountPar = marginPosition.initialHeldAmountPar.plus(marginPosition.marginDeposit.div(marketIndex.supplyIndex))
        marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(marginPosition.marginDeposit)
        marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountUSD.plus(marginPosition.marginDepositUSD)
        marginPosition.initialHeldPriceUSD = priceUSD
      }

      marginPosition.heldAmount = marginPosition.heldAmount.plus(transfer.amountDeltaWei)

      marginPosition.save()
    } else if (marginAccount2.accountNumber.equals(ZERO_BI) && marginAccount1.accountNumber.notEqual(ZERO_BI)) {
      // The user is closing the position or removing collateral
      if (token.id === marginPosition.heldToken) {
        marginPosition.heldAmount = marginPosition.heldAmount.minus(transfer.amountDeltaWei)

        if (marginPosition.heldAmount.le(ZERO_BD) && marginPosition.status === MarginPositionStatus.Open) {
          marginPosition.status = MarginPositionStatus.Closed
          marginPosition.closeTimestamp = event.block.timestamp

          marginPosition.closeHeldPriceUSD = priceUSD
          marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(marketIndex.supplyIndex)
          marginPosition.closeHeldAmountUSD = marginPosition.closeHeldAmountWei.times(priceUSD)

          let owedToken = Token.load(marginPosition.owedToken)
          if (owedToken !== null) {
            let owedTokenIndex = InterestIndex.load(owedToken.id)
            marginPosition.closeOwedPriceUSD = getOwedPriceUSD(dydxProtocol, marginPosition)
            marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex.borrowIndex)
            marginPosition.closeOwedAmountUSD = marginPosition.closeOwedAmountWei.times(marginPosition.closeOwedPriceUSD as BigDecimal)
          }
        }
      } else if (token.id === marginPosition.owedToken) {
        marginPosition.owedAmount = marginPosition.owedAmount.minus(transfer.amountDeltaWei)
      }

      marginPosition.save()
    }
  }

  updateAndReturnTokenHourDataForDyDxEvent(token, event)
  updateAndReturnTokenDayDataForDyDxEvent(token, event)
}

export function handleBuy(event: BuyEvent): void {
  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString()) as Token
  let takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString()) as Token

  let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
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

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerAccount = marginAccount.id
  trade.takerAccountAddress = Address.fromString(marginAccount.user)
  trade.makerAccount = null

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerNewParStruct.abs(), takerToken.decimals)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  let priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  let deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  trade.save()
  transaction.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false
  let soloMargin = getOrCreateSoloMarginForDyDxCall(event);
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin)

  let inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, true, makerIndex, takerIndex)
      marginPosition.save()
    }
  }
}

export function handleSell(event: SellEvent): void {
  let balanceUpdateOne = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerMarket,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerMarket,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let makerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.makerMarket).toHexString()) as Token
  let takerToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.takerMarket).toHexString()) as Token

  let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountNumber, event.block)
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

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerAccount = marginAccount.id
  trade.takerAccountAddress = Address.fromString(marginAccount.user)
  trade.makerAccount = null

  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  let takerDeltaWeiStruct = new ValueStruct(event.params.takerUpdate.deltaWei)
  let takerNewParStruct = new ValueStruct(event.params.takerUpdate.newPar)

  let makerDeltaWeiStruct = new ValueStruct(event.params.makerUpdate.deltaWei)
  let makerNewParStruct = new ValueStruct(event.params.makerUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerDeltaWeiStruct.abs(), takerToken.decimals)
  trade.makerTokenDeltaWei = convertStructToDecimal(makerDeltaWeiStruct.abs(), makerToken.decimals)

  let priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  let deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  marginAccount.save()
  trade.save()
  transaction.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let makerIndex = InterestIndex.load(event.params.makerMarket.toString()) as InterestIndex
  let takerIndex = InterestIndex.load(event.params.takerMarket.toString()) as InterestIndex
  let isVirtualTransfer = false
  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  changeProtocolBalance(makerToken, takerNewParStruct, takerDeltaWeiStruct, makerIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(takerToken, makerNewParStruct, makerDeltaWeiStruct, takerIndex, isVirtualTransfer, soloMargin)

  let inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(makerToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(takerToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(makerToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(takerToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, makerToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, takerToken, trade as Trade)

  if (marginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, marginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, true, makerIndex, takerIndex)
      marginPosition.save()
    }
  }
}

export function handleTrade(event: TradeEvent): void {
  let balanceUpdateOne = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.inputMarket,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.outputMarket,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.inputMarket,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.outputMarket,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let inputToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.inputMarket).toHexString()) as Token
  let outputToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.outputMarket).toHexString()) as Token

  let takerMarginAccount = getOrCreateMarginAccount(event.params.takerAccountOwner, event.params.takerAccountNumber, event.block)
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

  let makerMarginAccount = getOrCreateMarginAccount(event.params.makerAccountOwner, event.params.makerAccountNumber, event.block)
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

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
  }

  trade.transaction = transaction.id
  trade.logIndex = event.logIndex

  trade.takerAccount = takerMarginAccount.id
  trade.takerAccountAddress = Address.fromString(takerMarginAccount.user)
  trade.makerAccount = makerMarginAccount.id
  trade.makerAccountAddress = Address.fromString(makerMarginAccount.user)

  trade.takerToken = outputToken.id
  trade.makerToken = inputToken.id

  let takerInputDeltaWeiStruct = new ValueStruct(event.params.takerInputUpdate.deltaWei)
  let takerInputNewParStruct = new ValueStruct(event.params.takerInputUpdate.newPar)
  trade.takerTokenDeltaWei = convertStructToDecimal(takerInputDeltaWeiStruct.abs(), outputToken.decimals)

  let takerOutputDeltaWeiStruct = new ValueStruct(event.params.takerOutputUpdate.deltaWei)
  let takerOutputNewParStruct = new ValueStruct(event.params.takerOutputUpdate.newPar)
  trade.makerTokenDeltaWei = convertStructToDecimal(takerOutputDeltaWeiStruct.abs(), inputToken.decimals)

  let makerInputDeltaWeiStruct = new ValueStruct(event.params.makerInputUpdate.deltaWei)
  let makerInputNewParStruct = new ValueStruct(event.params.makerInputUpdate.newPar)

  let makerOutputDeltaWeiStruct = new ValueStruct(event.params.makerOutputUpdate.deltaWei)
  let makerOutputNewParStruct = new ValueStruct(event.params.makerOutputUpdate.newPar)

  let priceUSD = dydxProtocol.getMarketPrice(event.params.outputMarket)
  let deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerOutputUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  soloMargin.tradeCount = soloMargin.tradeCount.plus(ONE_BI)
  soloMargin.save()

  let dolomiteDayData = updateDolomiteDayData(event)

  let inputIndex = InterestIndex.load(event.params.inputMarket.toString()) as InterestIndex
  let outputIndex = InterestIndex.load(event.params.outputMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(inputToken, takerInputNewParStruct, takerInputDeltaWeiStruct, inputIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(outputToken, takerOutputNewParStruct, takerOutputDeltaWeiStruct, outputIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(inputToken, makerInputNewParStruct, makerInputDeltaWeiStruct, inputIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(outputToken, makerOutputNewParStruct, makerOutputDeltaWeiStruct, outputIndex, isVirtualTransfer, soloMargin)

  let inputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(inputToken, event)
  let outputTokenHourData = updateAndReturnTokenHourDataForDyDxEvent(outputToken, event)
  let inputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(inputToken, event)
  let outputTokenDayData = updateAndReturnTokenDayDataForDyDxEvent(outputToken, event)

  updateTimeDataForTrade(dolomiteDayData, inputTokenDayData, inputTokenHourData, inputToken, trade as Trade)
  updateTimeDataForTrade(dolomiteDayData, outputTokenDayData, outputTokenHourData, outputToken, trade as Trade)

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()

  if (makerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, makerMarginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, false, outputIndex, inputIndex)
      marginPosition.save()
    }
  }
  if (takerMarginAccount.accountNumber.notEqual(ZERO_BI)) {
    let marginPosition = getOrCreateMarginPosition(event, takerMarginAccount)
    if (marginPosition.status === MarginPositionStatus.Open) {
      updateMarginPositionForTrade(marginPosition, trade as Trade, event, dydxProtocol, false, inputIndex, outputIndex)
      marginPosition.save()
    }
  }
}

export function handleLiquidate(event: LiquidationEvent): void {
  let balanceUpdateOne = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.heldMarket,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.owedMarket,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  let balanceUpdateFour = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateFour, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString()) as Token
  let owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString()) as Token

  let liquidMarginAccount = getOrCreateMarginAccount(event.params.liquidAccountOwner, event.params.liquidAccountNumber, event.block)
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

  let solidMarginAccount = getOrCreateMarginAccount(event.params.solidAccountOwner, event.params.solidAccountNumber, event.block)
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

  let liquidationID = getIDForEvent(event)
  let liquidation = Liquidation.load(liquidationID)
  if (liquidation === null) {
    liquidation = new Liquidation(liquidationID)
  }

  liquidation.transaction = transaction.id
  liquidation.logIndex = event.logIndex

  liquidation.liquidAccount = liquidMarginAccount.id
  liquidation.liquidAccountAddress = Address.fromString(liquidMarginAccount.user)
  liquidation.solidAccount = solidMarginAccount.id
  liquidation.solidAccountAddress = Address.fromString(solidMarginAccount.user)

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

  let heldPriceUSD = dydxProtocol.getMarketPrice(event.params.heldMarket).value
  let owedPriceUSD = dydxProtocol.getMarketPrice(event.params.owedMarket).value

  let liquidationSpread = dydxProtocol.getLiquidationSpreadForPair(event.params.heldMarket, event.params.owedMarket).value
  let heldDeltaWei = event.params.solidHeldUpdate.deltaWei.value
  let heldTokenLiquidationRewardWei = heldDeltaWei.minus(heldDeltaWei.times(BI_ONE_ETH).div(liquidationSpread))
  liquidation.heldTokenLiquidationRewardWei = convertTokenToDecimal(heldTokenLiquidationRewardWei, heldToken.decimals)

  let owedDeltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.liquidOwedUpdate.deltaWei.value.abs().times(owedPriceUSD)
  )
  liquidation.debtUSDLiquidated = convertStructToDecimal(owedDeltaWeiUSD, BigInt.fromI32(36))

  let heldDeltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.liquidHeldUpdate.deltaWei.value.abs().times(heldPriceUSD)
  )
  liquidation.collateralUSDLiquidated = convertStructToDecimal(heldDeltaWeiUSD, BigInt.fromI32(36))

  let liquidationRewardUSD = ValueStruct.fromFields(
    true,
    heldTokenLiquidationRewardWei.times(heldPriceUSD)
  )
  liquidation.collateralUSDLiquidationReward = convertStructToDecimal(liquidationRewardUSD, BigInt.fromI32(36))

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  soloMargin.liquidationCount = soloMargin.liquidationCount.plus(ONE_BI)
  soloMargin.totalLiquidationVolumeUSD = soloMargin.totalLiquidationVolumeUSD.plus(liquidation.debtUSDLiquidated)
  soloMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  const isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(heldToken, liquidHeldNewParStruct, liquidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(owedToken, liquidOwedNewParStruct, liquidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin)

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
    if (marginPosition.status === MarginPositionStatus.Open || marginPosition.status === MarginPositionStatus.Liquidated) {
      marginPosition.status = MarginPositionStatus.Liquidated
      marginPosition.closeTimestamp = event.block.timestamp

      marginPosition.owedAmount = marginPosition.owedAmount.minus(liquidation.borrowedTokenAmountDeltaWei)
      marginPosition.heldAmount = marginPosition.heldAmount.minus(liquidation.heldTokenAmountDeltaWei)

      if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
        let heldPriceUSD = getTokenPriceUSD(heldToken, dydxProtocol)
        let owedPriceUSD = getTokenPriceUSD(owedToken, dydxProtocol)

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
  let balanceUpdateOne = new BalanceUpdate(
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.owedMarket,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateOne, event.block)

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.heldMarket,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateTwo, event.block)

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.owedMarket,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)

  let transaction = getOrCreateTransaction(event)

  let dydxProtocol = DyDx.bind(event.address)
  let heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString()) as Token
  let owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString()) as Token

  let vaporMarginAccount = getOrCreateMarginAccount(event.params.vaporAccountOwner, event.params.vaporAccountNumber, event.block)
  let vaporOwedNewParStruct = new ValueStruct(event.params.vaporOwedUpdate.newPar)
  let vaporOwedDeltaWeiStruct = new ValueStruct(event.params.vaporOwedUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    vaporMarginAccount,
    event,
    event.params.owedMarket,
    vaporOwedNewParStruct,
    owedToken
  )

  let solidMarginAccount = getOrCreateMarginAccount(event.params.solidAccountOwner, event.params.solidAccountNumber, event.block)

  let solidHeldNewParStruct = new ValueStruct(event.params.solidHeldUpdate.newPar)
  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.heldMarket,
    solidHeldNewParStruct,
    heldToken
  )

  let solidOwedNewParStruct = new ValueStruct(event.params.solidOwedUpdate.newPar)
  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  updateMarginAccountForEventAndSaveTokenValue(
    solidMarginAccount,
    event,
    event.params.owedMarket,
    solidOwedNewParStruct,
    owedToken
  )

  let vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
  }

  vaporization.transaction = transaction.id
  vaporization.logIndex = event.logIndex

  vaporization.vaporAccount = vaporMarginAccount.id
  vaporization.vaporAccountAddress = Address.fromString(vaporMarginAccount.user)
  vaporization.solidAccount = solidMarginAccount.id
  vaporization.solidAccountAddress = Address.fromString(solidMarginAccount.user)

  vaporization.heldToken = heldToken.id
  vaporization.borrowedToken = owedToken.id

  let borrowedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  vaporization.borrowedTokenAmountDeltaWei = convertStructToDecimal(borrowedDeltaWeiStruct.abs(), owedToken.decimals)

  let heldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  vaporization.heldTokenAmountDeltaWei = convertStructToDecimal(heldDeltaWeiStruct.abs(), heldToken.decimals)

  let owedPriceUSD = dydxProtocol.getMarketPrice(event.params.owedMarket).value

  vaporization.amountUSDVaporized = convertTokenToDecimal(owedPriceUSD.times(event.params.vaporOwedUpdate.deltaWei.value), BigInt.fromI32(36))

  let soloMargin = getOrCreateSoloMarginForDyDxCall(event)
  soloMargin.vaporizationCount = soloMargin.vaporizationCount.plus(ONE_BI)
  soloMargin.totalVaporizationVolumeUSD = soloMargin.totalVaporizationVolumeUSD.plus(vaporization.amountUSDVaporized)
  soloMargin.save()

  let heldIndex = InterestIndex.load(event.params.heldMarket.toString()) as InterestIndex
  let owedIndex = InterestIndex.load(event.params.owedMarket.toString()) as InterestIndex
  let isVirtualTransfer = true
  changeProtocolBalance(heldToken, solidHeldNewParStruct, solidHeldDeltaWeiStruct, heldIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(owedToken, solidOwedNewParStruct, solidOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin)
  changeProtocolBalance(owedToken, vaporOwedNewParStruct, vaporOwedDeltaWeiStruct, owedIndex, isVirtualTransfer, soloMargin)

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

  let dydx = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))
  let tokenAddress = dydx.getMarketTokenAddress(event.params.marketId).toHexString()
  let token = Token.load(tokenAddress) as Token

  let tokenValue = getOrCreateTokenValue(marginAccount, token)
  tokenValue.expirationTimestamp = event.block.timestamp
  tokenValue.save()
}
