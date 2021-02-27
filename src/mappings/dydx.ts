/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address } from '@graphprotocol/graph-ts'
import {
  Liquidation as LiquidationEvent,
  Vaporization as VaporizationEvent,
  Bundle
} from '../types/schema'
import { Pair as PairContract, Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
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

// TODO other events (BUY, SELL, TRANSFER, TRADE)
export function handleLiquidation(event: LiquidationEvent): void {
 // TODO
}

export function handleVaporization(event: VaporizationEvent): void {
 // TODO
}