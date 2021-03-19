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
import { Deposit, InterestIndex, MarginAccount, Token, TokenValue, Transfer, Withdrawal } from '../types/schema'
import { BI_18, convertStructToDecimal, convertTokenToDecimal } from './helpers'
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

  // TODO finish
  const buyID = getIDForEvent(event)
  let transfer = Transfer.load(buyID)
  if (transfer === null) {
    transfer = new Transfer(buyID)
  }

  transfer.transaction = transactionID
  transfer.fromAccount = event.params.updateOne.deltaWei.sign ? marginAccount2.id : marginAccount.id
  transfer.toAccount = event.params.updateOne.deltaWei.sign ? marginAccount.id : marginAccount2.id
  transfer.token = makerToken.id

  const amountDeltaWeiAbs = new ValueStruct(event.params.updateOne.deltaWei).abs()
  transfer.amountDeltaWei = convertStructToDecimal(amountDeltaWeiAbs, makerToken.decimals)
  const priceUSD = dydxProtocol.getMarketPrice(event.params.market)
  const deltaWeiUSD = ValueStruct.fromFields(
    amountDeltaWeiAbs.sign,
    amountDeltaWeiAbs.value.times(priceUSD.value)
  )
  transfer.amountUSDDeltaWei = convertStructToDecimal(deltaWeiUSD, BigInt.fromI32(36))

  const transfers = transaction.transfers
  transaction.transfers = transfers.concat([transfer.id])

  marginAccount.save()
  marginAccount2.save()
  transfer.save()
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
}
