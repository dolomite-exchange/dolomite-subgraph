/* eslint-disable prefer-const */
import {
  LogBuy as BuyEvent,
  LogDeposit as DepositEvent,
  LogIndexUpdate as IndexUpdateEvent,
  LogLiquidate as LiquidationEvent,
  LogSell as SellEvent,
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent
} from '../types/MarginTrade/DyDxEvents'
import {
  Deposit,
  InterestIndex,
  Liquidation,
  MarginAccount,
  Token,
  TokenValue,
  Trade,
  Transfer, Vaporization,
  Withdrawal
} from '../types/schema'
import { BI_18, BI_ONE_ETH, convertStructToDecimal, convertTokenToDecimal, ONE_BI } from './helpers'
import { getOrCreateTransaction } from './core'
import { BalanceUpdate, ValueStruct } from './dydx_types'
import { Address, BigInt, EthereumBlock, EthereumEvent } from '@graphprotocol/graph-ts'
import { DyDx } from '../types/MarginTrade/DyDx'

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
    marginAccount.user = owner
    marginAccount.accountId = accountNumber
    marginAccount.tokenValues = []
  }

  marginAccount.lastUpdatedBlockNumber = block.number
  marginAccount.lastUpdatedTimestamp = block.timestamp

  return marginAccount
}

function handleDyDxBalanceUpdate(balanceUpdate: BalanceUpdate, block: EthereumBlock): void {
  const id = `${balanceUpdate.accountOwner}-${balanceUpdate.accountNumber.toString()}`
  let marginAccount = getOrCreateMarginAccount(balanceUpdate.accountOwner, balanceUpdate.accountNumber, block)

  const tokenValueId = `${id}-${balanceUpdate.market.toString()}`
  const tokenValueIndex = marginAccount.tokenValues.indexOf(tokenValueId)
  let tokenValue: TokenValue
  if (tokenValueIndex === -1) {
    tokenValue = new TokenValue(tokenValueId)
    tokenValue.marketId = balanceUpdate.market

    const tokenValues = marginAccount.tokenValues
    tokenValues.push(tokenValueId)
    marginAccount.tokenValues = tokenValues
  } else {
    tokenValue = TokenValue.load(marginAccount.tokenValues[tokenValueIndex])
  }

  tokenValue.valuePar = balanceUpdate.valuePar

  tokenValue.save()
  marginAccount.save()
}

function getIDForEvent(event: EthereumEvent): string {
  return `${event.transaction.hash.toHexString()}-${event.logIndex.toString()}`
}

function getIDForTokenValue(marginAccount: MarginAccount, marketId: BigInt): string {
  return `${marginAccount.user.toHexString()}-${marginAccount.accountId.toString()}-${marketId.toString()}`
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
  const tokenValueIndex = marginAccount.tokenValues.indexOf(tokenValueID)
  if (tokenValueIndex === -1) {
    marginAccount.tokenValues = marginAccount.tokenValues.concat([tokenValueID])
  }

  let tokenValue = TokenValue.load(tokenValueID)
  if (tokenValue === null) {
    tokenValue = new TokenValue(tokenValueID)
    tokenValue.marketId = marketId
  }

  tokenValue.valuePar = convertStructToDecimal(newPar, token.decimals)
  tokenValue.save()
}

// TODO day stats

export function handleDeposit(event: DepositEvent): void {
  const balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  deposit.transaction = transactionID
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

  const deposits = transaction.deposits
  transaction.deposits = deposits.concat([deposit.id])

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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  withdrawal.transaction = transactionID
  withdrawal.logIndex = event.logIndex
  withdrawal.account = marginAccount.id
  withdrawal.token = token.id
  withdrawal.to = event.params.to
  withdrawal.amountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.update.deltaWei), token.decimals)
  const priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  const deltaWeiUSD = ValueStruct.fromFields(
    event.params.update.deltaWei.sign,
    event.params.update.deltaWei.value.times(priceUSD.value)
  )
  withdrawal.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const withdrawals = transaction.withdrawals
  transaction.withdrawals = withdrawals.concat([withdrawal.id])

  marginAccount.save()
  withdrawal.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  transfer.transaction = transactionID
  transfer.logIndex = event.logIndex
  transfer.fromAccount = event.params.updateOne.deltaWei.sign ? marginAccount2.id : marginAccount1.id
  transfer.toAccount = event.params.updateOne.deltaWei.sign ? marginAccount1.id : marginAccount2.id
  transfer.token = token.id

  const amountDeltaWeiAbs = new ValueStruct(event.params.updateOne.deltaWei).abs()
  transfer.amountDeltaWei = convertStructToDecimal(amountDeltaWeiAbs, token.decimals)
  const priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  const deltaWeiUSD = ValueStruct.fromFields(
    amountDeltaWeiAbs.sign,
    amountDeltaWeiAbs.value.times(priceUSD.value)
  )
  transfer.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const transfers = transaction.transfers
  transaction.transfers = transfers.concat([transfer.id])

  marginAccount1.save()
  marginAccount2.save()
  transfer.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  trade.transaction = transactionID
  trade.logIndex = event.logIndex
  trade.takerAccount = marginAccount.id
  trade.makerAccount = null
  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  trade.takerInputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.takerUpdate.deltaWei), takerToken.decimals)
  trade.takerOutputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.makerUpdate.deltaWei), makerToken.decimals)

  trade.makerInputDeltaWei = null
  trade.makerOutputDeltaWei = null

  const priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const trades = transaction.trades
  transaction.trades = trades.concat([trade.id])

  marginAccount.save()
  trade.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  trade.transaction = transactionID
  trade.logIndex = event.logIndex
  trade.takerAccount = marginAccount.id
  trade.makerAccount = null
  trade.takerToken = takerToken.id
  trade.makerToken = makerToken.id

  trade.takerInputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.takerUpdate.deltaWei), takerToken.decimals)
  trade.takerOutputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.makerUpdate.deltaWei), makerToken.decimals)

  trade.makerInputDeltaWei = null
  trade.makerOutputDeltaWei = null

  const priceUSD = dydxProtocol.getMarketPrice(event.params.takerMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const trades = transaction.trades
  transaction.trades = trades.concat([trade.id])

  marginAccount.save()
  trade.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  trade.transaction = transactionID
  trade.logIndex = event.logIndex
  trade.takerAccount = takerMarginAccount.id
  trade.makerAccount = makerMarginAccount.id
  trade.takerToken = outputToken.id
  trade.makerToken = inputToken.id

  trade.takerInputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.takerInputUpdate.deltaWei), outputToken.decimals)
  trade.takerOutputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.takerOutputUpdate.deltaWei), inputToken.decimals)

  trade.makerInputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.makerInputUpdate.deltaWei), inputToken.decimals)
  trade.makerOutputDeltaWei = convertStructToDecimal(new ValueStruct(event.params.makerOutputUpdate.deltaWei), outputToken.decimals)

  const priceUSD = dydxProtocol.getMarketPrice(event.params.outputMarket)
  const deltaWeiUSD = ValueStruct.fromFields(
    true,
    event.params.takerOutputUpdate.deltaWei.value.abs().times(priceUSD.value)
  )
  trade.amountUSD = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const trades = transaction.trades
  transaction.trades = trades.concat([trade.id])

  takerMarginAccount.save()
  makerMarginAccount.save()
  trade.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

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

  liquidation.transaction = transactionID
  liquidation.logIndex = event.logIndex
  liquidation.liquidAccount = liquidMarginAccount.id
  liquidation.solidAccount = solidMarginAccount.id
  liquidation.heldToken = heldToken.id
  liquidation.borrowedToken = owedToken.id

  liquidation.solidBorrowedTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.solidOwedUpdate.deltaWei), owedToken.decimals)
  liquidation.solidHeldTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.solidHeldUpdate.deltaWei), heldToken.decimals)

  liquidation.liquidBorrowedTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.liquidOwedUpdate.deltaWei), owedToken.decimals)
  liquidation.liquidHeldTokenAmountDeltaWei = convertStructToDecimal(new ValueStruct(event.params.liquidHeldUpdate.deltaWei), heldToken.decimals)

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

  const liquidations = transaction.liquidations
  transaction.liquidations = liquidations.concat([liquidation.id])

  liquidMarginAccount.save()
  solidMarginAccount.save()
  liquidation.save()
  transaction.save()
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

  const transactionID = event.transaction.hash.toHexString()
  const transaction = getOrCreateTransaction(transactionID, event)

  const dydxProtocol = DyDx.bind(event.address)
  const heldToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.heldMarket).toHexString())
  const owedToken = Token.load(dydxProtocol.getMarketTokenAddress(event.params.owedMarket).toHexString())

  const vaporMarginAccount = getOrCreateMarginAccount(event.params.vaporAccountOwner, event.params.vaporAccountNumber, event.block)
  updateMarginAccountForEventAndSaveTokenValue(
    vaporMarginAccount,
    event,
    event.params.owedMarket,
    new ValueStruct(event.params.vaporOwedUpdate.newPar),
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

  const vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
  }

  vaporization.transaction = transactionID
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

  const vaporizations = transaction.vaporizations
  transaction.vaporizations = vaporizations.concat([vaporization.id])

  vaporMarginAccount.save()
  solidMarginAccount.save()
  vaporization.save()
  transaction.save()
}
