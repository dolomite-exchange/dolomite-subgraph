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
import { InterestIndex, MarginAccount, TokenValue } from '../types/schema'
import { BI_18, convertTokenToDecimal } from './helpers'
import { BalanceUpdate } from './dydx_types'
import { EthereumBlock } from '@graphprotocol/graph-ts'

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

function handleDyDxBalanceUpdate(balanceUpdate: BalanceUpdate, block: EthereumBlock): void {
  const id = `${balanceUpdate.accountOwner}-${balanceUpdate.accountNumber.toString()}`
  let marginAccount = MarginAccount.load(id)
  if (marginAccount === null) {
    marginAccount = new MarginAccount(id)
    marginAccount.user = balanceUpdate.accountOwner
    marginAccount.accountId = balanceUpdate.accountNumber
  }

  marginAccount.lastUpdatedBlockNumber = block.number
  marginAccount.lastUpdatedTimestamp = block.timestamp

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

export function handleDeposit(event: DepositEvent): void {
  const balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.market,
    event.params.update.newPar.value,
    event.params.update.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdate, event.block)
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
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign
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
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign
  )
  handleDyDxBalanceUpdate(balanceUpdateThree, event.block)
}