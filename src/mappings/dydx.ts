/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address } from '@graphprotocol/graph-ts'
import {
  LogIndexUpdate as IndexUpdateEvent,
  LogDeposit as DepositEvent,
  LogWithdraw as WithdrawEvent,
  LogTransfer as TransferEvent,
  LogBuy as BuyEvent,
  LogSell as SellEvent,
  LogTrade as TradeEvent,
  LogLiquidate as LiquidationEvent,
  LogVaporize as VaporizationEvent,
} from '../types/MarginTrade/DyDxEvents'
import { updatePairDayData, updateTokenDayData, updateUniswapDayData, updatePairHourData } from './dayUpdates'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot
} from './helpers'

// TODO LogIndexUpdate

export function handleIndexUpdate(event: IndexUpdateEvent): void {
  // TODO
}

export function handleDeposit(event: DepositEvent): void {
  // TODO
}

export function handleWithdraw(event: WithdrawEvent): void {
  // TODO
}

export function handleTransfer(event: TransferEvent): void {
  // TODO
}

export function handleBuy(event: BuyEvent): void {
  // TODO
}

export function handleSell(event: SellEvent): void {
  // TODO
}

export function handleTrade(event: TradeEvent): void {
  // TODO
}

export function handleLiquidation(event: LiquidationEvent): void {
 // TODO
}

export function handleVaporization(event: VaporizationEvent): void {
 // TODO
}
