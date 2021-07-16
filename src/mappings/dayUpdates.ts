import {
  AmmFactory,
  AmmPair,
  AmmPairDayData,
  AmmPairHourData,
  Bundle,
  DolomiteDayData,
  DyDxSoloMargin,
  Liquidation,
  Token,
  TokenDayData,
  TokenHourData,
  Trade,
  Vaporization
} from '../types/schema'
import { BigInt, ethereum, BigDecimal } from '@graphprotocol/graph-ts'
import { FACTORY_ADDRESS, ONE_BI, SOLO_MARGIN_ADDRESS, ZERO_BD, ZERO_BI } from './helpers'
import { findETHPerTokenForTrade } from './pricing'

function setupDolomiteDayData(dolomiteDayData: DolomiteDayData, dayTimestamp: number): DolomiteDayData {
  dolomiteDayData.dayStartUnix = BigInt.fromI32(dayTimestamp as i32).toI32()

  // # Daily Figures
  // ## Daily Volume Figures USD
  dolomiteDayData.dailyAmmSwapVolumeUSD = ZERO_BD
  dolomiteDayData.dailyBorrowVolumeUSD = ZERO_BD
  dolomiteDayData.dailyLiquidationVolumeUSD = ZERO_BD
  dolomiteDayData.dailySupplyVolumeUSD = ZERO_BD
  dolomiteDayData.dailyTradeVolumeUSD = ZERO_BD
  dolomiteDayData.dailyVaporizationVolumeUSD = ZERO_BD

  // ## Daily Volume Figures Untracked
  dolomiteDayData.dailyAmmSwapVolumeUntracked = ZERO_BD

  // ## Daily Liquidity
  dolomiteDayData.ammLiquidityUSD = ZERO_BD
  dolomiteDayData.borrowLiquidityUSD = ZERO_BD
  dolomiteDayData.supplyLiquidityUSD = ZERO_BD

  // ## Daily Counts
  dolomiteDayData.totalAllTransactionCount = ZERO_BI
  dolomiteDayData.totalAmmSwapCount = ZERO_BI
  dolomiteDayData.totalLiquidationCount = ZERO_BI
  dolomiteDayData.totalTradeCount = ZERO_BI
  dolomiteDayData.totalVaporizationCount = ZERO_BI

  return dolomiteDayData
}

export function updateDolomiteDayData(event: ethereum.Event): DolomiteDayData {
  let factory = AmmFactory.load(FACTORY_ADDRESS)
  let soloMargin = DyDxSoloMargin.load(SOLO_MARGIN_ADDRESS)
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400

  let dolomiteDayData = DolomiteDayData.load(dayID.toString())
  if (dolomiteDayData === null) {
    dolomiteDayData = new DolomiteDayData(dayID.toString())
    setupDolomiteDayData(dolomiteDayData as DolomiteDayData, dayStartTimestamp)
  }

  // ## Daily Liquidity
  dolomiteDayData.ammLiquidityUSD = factory.ammLiquidityUSD
  dolomiteDayData.borrowLiquidityUSD = soloMargin.borrowLiquidityUSD
  dolomiteDayData.supplyLiquidityUSD = soloMargin.supplyLiquidityUSD

  // ## Total Counts
  dolomiteDayData.totalAllTransactionCount = soloMargin.transactionCount
  dolomiteDayData.totalAmmSwapCount = factory.transactionCount
  dolomiteDayData.totalLiquidationCount = soloMargin.liquidationCount
  dolomiteDayData.totalTradeCount = soloMargin.tradeCount
  dolomiteDayData.totalVaporizationCount = soloMargin.vaporizationCount

  dolomiteDayData.save()

  return dolomiteDayData as DolomiteDayData
}

export function updatePairDayData(event: ethereum.Event): AmmPairDayData {
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let dayPairID = event.address.toHexString() + '-' + BigInt.fromI32(dayID).toString()
  let pair = AmmPair.load(event.address.toHexString())

  let pairDayData = AmmPairDayData.load(dayPairID)
  if (pairDayData === null) {
    pairDayData = new AmmPairDayData(dayPairID)
    pairDayData.dayStartUnix = dayStartTimestamp
    pairDayData.token0 = pair.token0
    pairDayData.token1 = pair.token1
    pairDayData.pairAddress = event.address
    pairDayData.dailyVolumeToken0 = ZERO_BD
    pairDayData.dailyVolumeToken1 = ZERO_BD
    pairDayData.dailyVolumeUSD = ZERO_BD
    pairDayData.dailyTransactionCount = ZERO_BI
  }

  pairDayData.totalSupply = pair.totalSupply
  pairDayData.reserve0 = pair.reserve0
  pairDayData.reserve1 = pair.reserve1
  pairDayData.reserveUSD = pair.reserveUSD
  pairDayData.dailyTransactionCount = pairDayData.dailyTransactionCount.plus(ONE_BI)
  pairDayData.save()

  return pairDayData as AmmPairDayData
}

export function updatePairHourData(event: ethereum.Event): AmmPairHourData {
  let timestamp = event.block.timestamp.toI32()
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  let hourPairID = event.address.toHexString() + '-' + BigInt.fromI32(hourIndex).toString()
  let pair = AmmPair.load(event.address.toHexString())

  let pairHourData = AmmPairHourData.load(hourPairID)
  if (pairHourData === null) {
    pairHourData = new AmmPairHourData(hourPairID)
    pairHourData.hourStartUnix = hourStartUnix
    pairHourData.pairAddress = event.address
    pairHourData.token0 = pair.token0
    pairHourData.token1 = pair.token1
    pairHourData.hourlyVolumeToken0 = ZERO_BD
    pairHourData.hourlyVolumeToken1 = ZERO_BD
    pairHourData.hourlyVolumeUSD = ZERO_BD
    pairHourData.hourlyTransactionCount = ZERO_BI
  }

  pairHourData.reserve0 = pair.reserve0
  pairHourData.reserve1 = pair.reserve1
  pairHourData.reserveUSD = pair.reserveUSD
  pairHourData.hourlyTransactionCount = pairHourData.hourlyTransactionCount.plus(ONE_BI)
  pairHourData.save()

  return pairHourData as AmmPairHourData
}

function setupTokenHourData(tokenHourData: TokenHourData, hourStartTimestamp: number, token: Token): TokenHourData {
  tokenHourData.hourStartUnix = hourStartTimestamp as i32
  tokenHourData.token = token.id

  // # Hourly Figures
  // ## Hourly Volume Figures USD
  tokenHourData.hourlyAmmSwapVolumeUSD = ZERO_BD
  tokenHourData.hourlyBorrowVolumeUSD = ZERO_BD
  tokenHourData.hourlyLiquidationVolumeUSD = ZERO_BD
  tokenHourData.hourlyTradeVolumeUSD = ZERO_BD
  tokenHourData.hourlyVaporizationVolumeUSD = ZERO_BD

  // ## Hourly Volume Figures Token
  tokenHourData.hourlyAmmSwapVolumeToken = ZERO_BD
  tokenHourData.hourlyBorrowVolumeToken = ZERO_BD
  tokenHourData.hourlyLiquidationVolumeToken = ZERO_BD
  tokenHourData.hourlyTradeVolumeToken = ZERO_BD
  tokenHourData.hourlyVaporizationVolumeToken = ZERO_BD

  // ## Hourly Liquidity USD
  tokenHourData.ammLiquidityUSD = ZERO_BD
  tokenHourData.borrowLiquidityUSD = ZERO_BD
  tokenHourData.supplyLiquidityUSD = ZERO_BD

  // ## Hourly Liquidity Token
  tokenHourData.ammLiquidityToken = ZERO_BD
  tokenHourData.borrowLiquidityToken = ZERO_BD
  tokenHourData.supplyLiquidityToken = ZERO_BD

  // ## Hourly Counts
  tokenHourData.hourlyAllTransactionCount = ZERO_BI
  tokenHourData.hourlyAmmSwapCount = ZERO_BI
  tokenHourData.hourlyLiquidationCount = ZERO_BI
  tokenHourData.hourlyTradeCount = ZERO_BI
  tokenHourData.hourlyVaporizationCount = ZERO_BI

  // # Price stats
  tokenHourData.ammPriceUSD = ZERO_BD
  tokenHourData.openPriceUSD = ZERO_BD
  tokenHourData.highPriceUSD = ZERO_BD
  tokenHourData.lowPriceUSD = ZERO_BD
  tokenHourData.closePriceUSD = ZERO_BD

  return tokenHourData
}

export function updateTokenHourDataForAmmEvent(token: Token, event: ethereum.Event): TokenHourData {
  let bundle = Bundle.load('1')
  let timestamp = event.block.timestamp.toI32()
  let hourID = timestamp / 3600
  let hourStartTimestamp = hourID * 3600
  let tokenHourID = token.id + '-' + BigInt.fromI32(hourID).toString()

  let tokenHourData = TokenHourData.load(tokenHourID)
  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    setupTokenHourData(tokenHourData as TokenHourData, hourStartTimestamp, token)
  }

  tokenHourData.ammPriceUSD = token.derivedETH.times(bundle.ethPrice)
  tokenHourData.ammLiquidityToken = token.ammSwapLiquidity
  tokenHourData.ammLiquidityUSD = token.ammSwapLiquidity.times(token.derivedETH as BigDecimal).times(bundle.ethPrice)
  tokenHourData.hourlyAllTransactionCount = tokenHourData.hourlyAllTransactionCount.plus(ONE_BI)
  tokenHourData.save()

  /**
   * @todo test if this speeds up sync
   */
  // updateStoredTokens(tokenHourData as TokenDayData, dayID)
  // updateStoredPairs(tokenHourData as TokenDayData, dayPairID)

  return tokenHourData as TokenHourData
}

function setupTokenDayData(tokenDayData: TokenDayData, dayStartTimestamp: number, token: Token): TokenDayData {
  tokenDayData.dayStartUnix = dayStartTimestamp as i32
  tokenDayData.token = token.id

  // # Daily Figures
  // ## Daily Volume Figures USD
  tokenDayData.dailyAmmSwapVolumeUSD = ZERO_BD
  tokenDayData.dailyBorrowVolumeUSD = ZERO_BD
  tokenDayData.dailyLiquidationVolumeUSD = ZERO_BD
  tokenDayData.dailyTradeVolumeUSD = ZERO_BD
  tokenDayData.dailyVaporizationVolumeUSD = ZERO_BD

  // ## Daily Volume Figures Token
  tokenDayData.dailyAmmSwapVolumeToken = ZERO_BD
  tokenDayData.dailyBorrowVolumeToken = ZERO_BD
  tokenDayData.dailyLiquidationVolumeToken = ZERO_BD
  tokenDayData.dailyTradeVolumeToken = ZERO_BD
  tokenDayData.dailyVaporizationVolumeToken = ZERO_BD

  // ## Daily Liquidity USD
  tokenDayData.ammLiquidityUSD = ZERO_BD
  tokenDayData.borrowLiquidityUSD = ZERO_BD
  tokenDayData.supplyLiquidityUSD = ZERO_BD

  // ## Daily Liquidity Token
  tokenDayData.ammLiquidityToken = ZERO_BD
  tokenDayData.borrowLiquidityToken = ZERO_BD
  tokenDayData.supplyLiquidityToken = ZERO_BD

  // ## Daily Counts
  tokenDayData.dailyAllTransactionCount = ZERO_BI
  tokenDayData.dailyAmmSwapCount = ZERO_BI
  tokenDayData.dailyLiquidationCount = ZERO_BI
  tokenDayData.dailyTradeCount = ZERO_BI
  tokenDayData.dailyVaporizationCount = ZERO_BI

  // # Price stats
  tokenDayData.ammPriceUSD = ZERO_BD
  tokenDayData.openPriceUSD = ZERO_BD
  tokenDayData.highPriceUSD = ZERO_BD
  tokenDayData.lowPriceUSD = ZERO_BD
  tokenDayData.closePriceUSD = ZERO_BD

  return tokenDayData
}

export function updateTokenDayDataForAmmEvent(token: Token, event: ethereum.Event): TokenDayData {
  let bundle = Bundle.load('1')
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let tokenDayID = token.id + '-' + BigInt.fromI32(dayID).toString()

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    setupTokenDayData(tokenDayData as TokenDayData, dayStartTimestamp, token)
  }

  tokenDayData.ammPriceUSD = token.derivedETH.times(bundle.ethPrice)
  tokenDayData.ammLiquidityToken = token.ammSwapLiquidity
  tokenDayData.ammLiquidityUSD = token.ammSwapLiquidity.times(token.derivedETH as BigDecimal).times(bundle.ethPrice)
  tokenDayData.dailyAllTransactionCount = tokenDayData.dailyAllTransactionCount.plus(ONE_BI)
  tokenDayData.save()

  return tokenDayData as TokenDayData
}

export function updateAndReturnTokenHourDataForDyDxEvent(token: Token, event: ethereum.Event): TokenHourData {
  let timestamp = event.block.timestamp
  let hourID = timestamp.div(BigInt.fromI32(3600)).times(BigInt.fromI32(3600))
  let tokenHourID = token.id + '-' + hourID.toString()

  let tokenHourData = TokenHourData.load(tokenHourID)
  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    setupTokenHourData(tokenHourData as TokenHourData, hourID.toI32(), token)
  }

  tokenHourData.borrowLiquidityToken = token.borrowLiquidity
  tokenHourData.supplyLiquidityToken = token.supplyLiquidity

  tokenHourData.borrowLiquidityUSD = token.borrowLiquidityUSD
  tokenHourData.supplyLiquidityUSD = token.supplyLiquidityUSD

  tokenHourData.hourlyAllTransactionCount = tokenHourData.hourlyAllTransactionCount.plus(ONE_BI)

  tokenHourData.save()

  return tokenHourData as TokenHourData
}

export function updateAndReturnTokenDayDataForDyDxEvent(token: Token, event: ethereum.Event): TokenDayData {
  let timestamp = event.block.timestamp
  let dayID = timestamp.div(BigInt.fromI32(86400)).times(BigInt.fromI32(86400))
  let tokenDayID = token.id + '-' + dayID.toString()

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    setupTokenDayData(tokenDayData as TokenDayData, dayID.toI32(), token)
  }

  tokenDayData.borrowLiquidityToken = token.borrowLiquidity
  tokenDayData.supplyLiquidityToken = token.supplyLiquidity

  tokenDayData.borrowLiquidityUSD = token.borrowLiquidityUSD
  tokenDayData.supplyLiquidityUSD = token.supplyLiquidityUSD

  tokenDayData.dailyAllTransactionCount = tokenDayData.dailyAllTransactionCount.plus(ONE_BI)

  tokenDayData.save()

  return tokenDayData as TokenDayData
}

export function updateTimeDataForTrade(
  dolomiteDayData: DolomiteDayData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  trade: Trade
): void {
  let bundle = Bundle.load('1')
  let dayID = tokenDayData.dayStartUnix / 86400
  let hourID = tokenHourData.hourStartUnix / 3600

  // Using the below examples of buying / selling, token == USD || token == ETH
  let closePriceETH = findETHPerTokenForTrade(trade, token)
  let closePriceUSD = bundle.ethPrice.times(closePriceETH)

  // IE: BUY 4 ETH @ $300 --> outputDeltaWei = $1200; inputDeltaWei = 4 ETH; takerToken = USD; makerToken = ETH
  // IE: SELL 4 ETH @ $300 --> outputDeltaWei = 4 ETH; inputDeltaWei = $1200; takerToken = ETH; makerToken = USD
  if (trade.takerToken == token.id) {
    let amountUSD = trade.takerTokenDeltaWei.times(closePriceUSD)

    dolomiteDayData.dailyTradeVolumeUSD = dolomiteDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenDayData.dailyTradeVolumeToken = tokenDayData.dailyTradeVolumeToken.plus(trade.takerTokenDeltaWei)
    tokenDayData.dailyTradeVolumeUSD = tokenDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenHourData.hourlyTradeVolumeToken = tokenHourData.hourlyTradeVolumeToken.plus(trade.takerTokenDeltaWei)
    tokenHourData.hourlyTradeVolumeUSD = tokenHourData.hourlyTradeVolumeUSD.plus(amountUSD)
  } else {
    // trade.makerToken == token.id
    let amountUSD = trade.makerTokenDeltaWei.times(closePriceUSD)

    dolomiteDayData.dailyTradeVolumeUSD = dolomiteDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenDayData.dailyTradeVolumeToken = tokenDayData.dailyTradeVolumeToken.plus(trade.makerTokenDeltaWei)
    tokenDayData.dailyTradeVolumeUSD = tokenDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenHourData.hourlyTradeVolumeToken = tokenHourData.hourlyTradeVolumeToken.plus(trade.makerTokenDeltaWei)
    tokenHourData.hourlyTradeVolumeUSD = tokenHourData.hourlyTradeVolumeUSD.plus(amountUSD)
  }

  tokenDayData.dailyTradeCount = tokenDayData.dailyTradeCount.plus(ONE_BI)
  tokenHourData.hourlyTradeCount = tokenHourData.hourlyTradeCount.plus(ONE_BI)

  // Price stats
  if (tokenDayData.openPriceUSD.equals(ZERO_BD)) {
    let previousDayTokenId = token.id + '-' + BigInt.fromI32(dayID - 1).toString()
    let previousDayToken = TokenDayData.load(previousDayTokenId)
    if (previousDayToken === null) {
      tokenDayData.openPriceUSD = closePriceUSD
    } else {
      tokenDayData.openPriceUSD = previousDayToken.closePriceUSD
    }
    tokenDayData.highPriceUSD = tokenDayData.openPriceUSD
    tokenDayData.lowPriceUSD = tokenDayData.openPriceUSD
  }
  if (tokenHourData.openPriceUSD.equals(ZERO_BD)) {
    let previousHourTokenId = token.id + '-' + BigInt.fromI32(hourID - 1).toString()
    let previousHourToken = TokenHourData.load(previousHourTokenId)
    if (previousHourToken === null) {
      tokenHourData.openPriceUSD = closePriceUSD
    } else {
      tokenHourData.openPriceUSD = previousHourToken.closePriceUSD
    }
    tokenHourData.highPriceUSD = tokenHourData.openPriceUSD
    tokenHourData.lowPriceUSD = tokenHourData.openPriceUSD
  }

  if (tokenDayData.lowPriceUSD.gt(closePriceUSD)) {
    tokenDayData.lowPriceUSD = closePriceUSD
  }
  if (tokenHourData.lowPriceUSD.gt(closePriceUSD)) {
    tokenHourData.lowPriceUSD = closePriceUSD
  }

  if (tokenDayData.highPriceUSD.lt(closePriceUSD)) {
    tokenDayData.highPriceUSD = closePriceUSD
  }
  if (tokenHourData.highPriceUSD.lt(closePriceUSD)) {
    tokenHourData.highPriceUSD = closePriceUSD
  }

  tokenDayData.closePriceUSD = closePriceUSD
  tokenHourData.closePriceUSD = closePriceUSD

  tokenDayData.save()
  tokenHourData.save()
  dolomiteDayData.save()
}

export function updateTimeDataForLiquidation(
  dolomiteDayData: DolomiteDayData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  liquidation: Liquidation
): void {
  if (liquidation.borrowedToken == token.id) {
    let bundle = Bundle.load('1')

    let liquidationVolumeToken = liquidation.borrowedTokenAmountDeltaWei
    if (liquidationVolumeToken.lt(ZERO_BD)) {
      // This should always be positive but just to be sure
      liquidationVolumeToken = ZERO_BD.minus(liquidationVolumeToken)
    }

    let liquidationVolumeUSD = liquidationVolumeToken.times(token.derivedETH as BigDecimal).times(bundle.ethPrice)

    tokenDayData.dailyLiquidationVolumeToken = tokenDayData.dailyLiquidationVolumeToken.plus(liquidationVolumeToken)
    tokenDayData.dailyLiquidationVolumeUSD = tokenDayData.dailyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    tokenDayData.dailyLiquidationCount = tokenDayData.dailyLiquidationCount.plus(ONE_BI)

    tokenHourData.hourlyLiquidationVolumeToken = tokenHourData.hourlyLiquidationVolumeToken.plus(liquidationVolumeToken)
    tokenHourData.hourlyLiquidationVolumeUSD = tokenHourData.hourlyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    tokenHourData.hourlyLiquidationCount = tokenHourData.hourlyLiquidationCount.plus(ONE_BI)

    dolomiteDayData.dailyLiquidationVolumeUSD = dolomiteDayData.dailyLiquidationVolumeUSD.plus(liquidationVolumeUSD)

    tokenDayData.save()
    tokenHourData.save()
    dolomiteDayData.save()
  }
}

export function updateTimeDataForVaporization(
  dolomiteDayData: DolomiteDayData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  vaporization: Vaporization
): void {
  if (vaporization.borrowedToken == token.id) {
    let bundle = Bundle.load('1')

    let vaporizationVolumeToken = vaporization.borrowedTokenAmountDeltaWei
    if (vaporizationVolumeToken.lt(ZERO_BD)) {
      // This should always be positive but just to be sure
      vaporizationVolumeToken = ZERO_BD.minus(vaporizationVolumeToken)
    }

    let vaporizationVolumeUSD = vaporizationVolumeToken.times(token.derivedETH as BigDecimal).times(bundle.ethPrice)

    tokenDayData.dailyVaporizationVolumeToken = tokenDayData.dailyVaporizationVolumeToken.plus(vaporizationVolumeToken)
    tokenDayData.dailyVaporizationVolumeUSD = tokenDayData.dailyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    tokenDayData.dailyVaporizationCount = tokenDayData.dailyVaporizationCount.plus(ONE_BI)

    tokenHourData.hourlyVaporizationVolumeToken = tokenHourData.hourlyVaporizationVolumeToken.plus(vaporizationVolumeToken)
    tokenHourData.hourlyVaporizationVolumeUSD = tokenHourData.hourlyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    tokenHourData.hourlyVaporizationCount = tokenHourData.hourlyVaporizationCount.plus(ONE_BI)

    dolomiteDayData.dailyVaporizationVolumeUSD = dolomiteDayData.dailyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    dolomiteDayData.totalVaporizationCount = dolomiteDayData.totalVaporizationCount.plus(ONE_BI)

    tokenDayData.save()
    dolomiteDayData.save()
  }
}
