import {
  AmmFactory,
  AmmPair,
  AmmPairDayData,
  AmmPairHourData,
  DolomiteDayData, DolomiteHourData,
  DolomiteMargin,
  Liquidation,
  MostRecentTrade,
  Token,
  TokenDayData,
  TokenHourData,
  Trade,
  Vaporization,
} from '../types/schema'
import { BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import { DOLOMITE_MARGIN_ADDRESS, FACTORY_ADDRESS, ONE_BI, WETH_ADDRESS, ZERO_BD, ZERO_BI } from './generated/constants'
import { absBD } from './helpers'
import { getTokenOraclePriceUSD } from './pricing'
import { ProtocolType } from './margin-types'

function getDayId(timestamp: BigInt): string {
  let _86400 = BigInt.fromI32(86400)
  return timestamp.div(_86400).times(_86400).toString()
}

function getHourId(timestamp: BigInt): string {
  let _3600 = BigInt.fromI32(3600)
  return timestamp.div(_3600).times(_3600).toString()
}

function setupDolomiteDayData(dolomiteDayData: DolomiteDayData): DolomiteDayData {
  dolomiteDayData.dayStartUnix = BigInt.fromString(dolomiteDayData.id).toI32()

  // # Daily Figures
  // ## Daily Volume Figures USD
  dolomiteDayData.dailyAmmTradeVolumeUSD = ZERO_BD
  dolomiteDayData.dailyBorrowVolumeUSD = ZERO_BD
  dolomiteDayData.dailyLiquidationVolumeUSD = ZERO_BD
  dolomiteDayData.dailySupplyVolumeUSD = ZERO_BD
  dolomiteDayData.dailyTradeVolumeUSD = ZERO_BD
  dolomiteDayData.dailyVaporizationVolumeUSD = ZERO_BD

  // ## Daily Volume Figures Untracked
  dolomiteDayData.dailyAmmTradeVolumeUntracked = ZERO_BD

  // ## Daily Liquidity
  dolomiteDayData.ammLiquidityUSD = ZERO_BD
  dolomiteDayData.borrowLiquidityUSD = ZERO_BD
  dolomiteDayData.supplyLiquidityUSD = ZERO_BD

  // ## Daily Counts
  dolomiteDayData.dailyAmmTradeCount = ZERO_BI
  dolomiteDayData.dailyLiquidationCount = ZERO_BI
  dolomiteDayData.dailyTradeCount = ZERO_BI
  dolomiteDayData.dailyVaporizationCount = ZERO_BI

  // ## Running Total Counts
  dolomiteDayData.totalAllTransactionCount = ZERO_BI
  dolomiteDayData.totalAmmTradeCount = ZERO_BI
  dolomiteDayData.totalLiquidationCount = ZERO_BI
  dolomiteDayData.totalTradeCount = ZERO_BI
  dolomiteDayData.totalVaporizationCount = ZERO_BI

  return dolomiteDayData
}

function setupDolomiteHourData(dolomiteHourData: DolomiteHourData): DolomiteHourData {
  dolomiteHourData.hourStartUnix = BigInt.fromString(dolomiteHourData.id).toI32()

  // # Daily Figures
  // ## Daily Volume Figures USD
  dolomiteHourData.hourlyAmmTradeVolumeUSD = ZERO_BD
  dolomiteHourData.hourlyBorrowVolumeUSD = ZERO_BD
  dolomiteHourData.hourlyLiquidationVolumeUSD = ZERO_BD
  dolomiteHourData.hourlySupplyVolumeUSD = ZERO_BD
  dolomiteHourData.hourlyTradeVolumeUSD = ZERO_BD
  dolomiteHourData.hourlyVaporizationVolumeUSD = ZERO_BD

  // ## Daily Volume Figures Untracked
  dolomiteHourData.hourlyAmmTradeVolumeUntracked = ZERO_BD

  // ## Daily Liquidity
  dolomiteHourData.ammLiquidityUSD = ZERO_BD
  dolomiteHourData.borrowLiquidityUSD = ZERO_BD
  dolomiteHourData.supplyLiquidityUSD = ZERO_BD

  // ## Daily Counts
  dolomiteHourData.hourlyAmmTradeCount = ZERO_BI
  dolomiteHourData.hourlyLiquidationCount = ZERO_BI
  dolomiteHourData.hourlyTradeCount = ZERO_BI
  dolomiteHourData.hourlyVaporizationCount = ZERO_BI

  // ## Running Total Counts
  dolomiteHourData.totalAllTransactionCount = ZERO_BI
  dolomiteHourData.totalAmmTradeCount = ZERO_BI
  dolomiteHourData.totalLiquidationCount = ZERO_BI
  dolomiteHourData.totalTradeCount = ZERO_BI
  dolomiteHourData.totalVaporizationCount = ZERO_BI

  return dolomiteHourData
}

export function updateDolomiteDayData(event: ethereum.Event): DolomiteDayData {
  let factory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  let dayId = getDayId(event.block.timestamp)

  let dolomiteDayData = DolomiteDayData.load(dayId)
  if (dolomiteDayData === null) {
    dolomiteDayData = new DolomiteDayData(dayId)
    setupDolomiteDayData(dolomiteDayData as DolomiteDayData)
  }

  // ## Daily Liquidity
  dolomiteDayData.ammLiquidityUSD = factory.ammLiquidityUSD
  dolomiteDayData.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD
  dolomiteDayData.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD

  // ## Total Counts
  dolomiteDayData.totalAllTransactionCount = dolomiteMargin.transactionCount
  dolomiteDayData.totalAmmTradeCount = factory.transactionCount
  dolomiteDayData.totalLiquidationCount = dolomiteMargin.liquidationCount
  dolomiteDayData.totalTradeCount = dolomiteMargin.tradeCount
  dolomiteDayData.totalVaporizationCount = dolomiteMargin.vaporizationCount

  dolomiteDayData.save()

  return dolomiteDayData as DolomiteDayData
}

export function updateDolomiteHourData(event: ethereum.Event): DolomiteHourData {
  let factory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  let hourId = getHourId(event.block.timestamp)

  let dolomiteHourData = DolomiteHourData.load(hourId)
  if (dolomiteHourData === null) {
    dolomiteHourData = new DolomiteHourData(hourId)
    setupDolomiteHourData(dolomiteHourData as DolomiteHourData)
  }

  // ## Hourly Liquidity
  dolomiteHourData.ammLiquidityUSD = factory.ammLiquidityUSD
  dolomiteHourData.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD
  dolomiteHourData.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD

  // ## Total Counts
  dolomiteHourData.totalAllTransactionCount = dolomiteMargin.transactionCount
  dolomiteHourData.totalAmmTradeCount = factory.transactionCount
  dolomiteHourData.totalLiquidationCount = dolomiteMargin.liquidationCount
  dolomiteHourData.totalTradeCount = dolomiteMargin.tradeCount
  dolomiteHourData.totalVaporizationCount = dolomiteMargin.vaporizationCount

  dolomiteHourData.save()

  return dolomiteHourData as DolomiteHourData
}

export function updatePairDayData(event: ethereum.Event): AmmPairDayData {
  let dayId = getDayId(event.block.timestamp)
  let dayPairID = `${event.address.toHexString()}-${dayId}`
  let pair = AmmPair.load(event.address.toHexString()) as AmmPair

  let pairDayData = AmmPairDayData.load(dayPairID)
  if (pairDayData === null) {
    pairDayData = new AmmPairDayData(dayPairID)
    pairDayData.dayStartUnix = BigInt.fromString(dayId).toI32()
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
  let hourId = getHourId(event.block.timestamp)
  let hourPairID = `${event.address.toHexString()}-${hourId}`
  let pair = AmmPair.load(event.address.toHexString()) as AmmPair

  let pairHourData = AmmPairHourData.load(hourPairID)
  if (pairHourData === null) {
    pairHourData = new AmmPairHourData(hourPairID)
    pairHourData.hourStartUnix = BigInt.fromString(hourId).toI32()
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

function setupTokenHourData(
  tokenHourData: TokenHourData,
  hourId: i32,
  token: Token,
  event: ethereum.Event,
  protocolType: string,
): TokenHourData {
  tokenHourData.hourStartUnix = hourId
  tokenHourData.token = token.id

  // # Hourly Figures
  // ## Hourly Volume Figures USD
  tokenHourData.hourlyAmmTradeVolumeUSD = ZERO_BD
  tokenHourData.hourlyBorrowVolumeUSD = ZERO_BD
  tokenHourData.hourlyLiquidationVolumeUSD = ZERO_BD
  tokenHourData.hourlyTradeVolumeUSD = ZERO_BD
  tokenHourData.hourlyVaporizationVolumeUSD = ZERO_BD

  // ## Hourly Volume Figures Token
  tokenHourData.hourlyAmmTradeVolumeToken = ZERO_BD
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
  tokenHourData.hourlyAmmTradeCount = ZERO_BI
  tokenHourData.hourlyLiquidationCount = ZERO_BI
  tokenHourData.hourlyTradeCount = ZERO_BI
  tokenHourData.hourlyVaporizationCount = ZERO_BI

  // # Price stats
  let previousHourTokenId = `${token.id}-${BigInt.fromI32(hourId - 3600).toString()}`
  let previousHourToken = TokenHourData.load(previousHourTokenId)
  if (previousHourToken === null) {
    let mostRecentTrade = MostRecentTrade.load(token.id)
    if (mostRecentTrade === null) {
      tokenHourData.openPriceUSD = ZERO_BD
    } else {
      let trade = Trade.load(mostRecentTrade.trade) as Trade
      let otherToken = Token.load(trade.takerToken == token.id ? trade.makerToken : trade.takerToken) as Token
      let otherPriceUSD = getTokenOraclePriceUSD(otherToken, event, protocolType)
      tokenHourData.openPriceUSD = token.id == trade.takerToken
        ? trade.makerTokenDeltaWei.div(trade.takerTokenDeltaWei).times(otherPriceUSD).truncate(36)
        : trade.takerTokenDeltaWei.div(trade.makerTokenDeltaWei).times(otherPriceUSD).truncate(36)
    }
  } else {
    tokenHourData.openPriceUSD = previousHourToken.closePriceUSD
  }

  tokenHourData.ammPriceUSD = ZERO_BD
  tokenHourData.highPriceUSD = tokenHourData.openPriceUSD
  tokenHourData.lowPriceUSD = tokenHourData.openPriceUSD
  tokenHourData.closePriceUSD = tokenHourData.openPriceUSD

  return tokenHourData
}

export function updateTokenHourDataForAmmEvent(token: Token, event: ethereum.Event): TokenHourData {
  let ethToken = Token.load(WETH_ADDRESS) as Token
  let ethPriceUSD = getTokenOraclePriceUSD(ethToken, event, ProtocolType.Amm)
  let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Amm)
  let hourId = getHourId(event.block.timestamp)
  let tokenHourID = `${token.id}-${hourId}`

  let tokenHourData = TokenHourData.load(tokenHourID)
  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    setupTokenHourData(
      tokenHourData as TokenHourData,
      BigInt.fromString(hourId).toI32(),
      token,
      event,
      ProtocolType.Amm,
    )
  }

  tokenHourData.ammPriceUSD = (token.derivedETH as BigDecimal).times(ethPriceUSD).truncate(18)
  tokenHourData.ammLiquidityToken = token.ammTradeLiquidity
  tokenHourData.ammLiquidityUSD = token.ammTradeLiquidity.times(tokenPriceUSD).truncate(18)
  tokenHourData.hourlyAllTransactionCount = tokenHourData.hourlyAllTransactionCount.plus(ONE_BI)
  tokenHourData.save()

  return tokenHourData as TokenHourData
}

function setupTokenDayData(
  tokenDayData: TokenDayData,
  dayId: i32,
  token: Token,
  event: ethereum.Event,
  protocolType: string,
): TokenDayData {
  tokenDayData.dayStartUnix = dayId
  tokenDayData.token = token.id

  // # Daily Figures
  // ## Daily Volume Figures USD
  tokenDayData.dailyAmmTradeVolumeUSD = ZERO_BD
  tokenDayData.dailyBorrowVolumeUSD = ZERO_BD
  tokenDayData.dailyLiquidationVolumeUSD = ZERO_BD
  tokenDayData.dailyTradeVolumeUSD = ZERO_BD
  tokenDayData.dailyVaporizationVolumeUSD = ZERO_BD

  // ## Daily Volume Figures Token
  tokenDayData.dailyAmmTradeVolumeToken = ZERO_BD
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
  tokenDayData.dailyAmmTradeCount = ZERO_BI
  tokenDayData.dailyLiquidationCount = ZERO_BI
  tokenDayData.dailyTradeCount = ZERO_BI
  tokenDayData.dailyVaporizationCount = ZERO_BI

  // # Price stats
  let previousHourTokenId = `${token.id}-${BigInt.fromI32(dayId - 86400).toString()}`
  let previousHourToken = TokenHourData.load(previousHourTokenId)
  if (previousHourToken === null) {
    let mostRecentTrade = MostRecentTrade.load(token.id)
    if (mostRecentTrade === null) {
      tokenDayData.openPriceUSD = ZERO_BD
    } else {
      let trade = Trade.load(mostRecentTrade.trade) as Trade
      let otherToken = Token.load(trade.takerToken == token.id ? trade.makerToken : trade.takerToken) as Token
      let otherPriceUSD = getTokenOraclePriceUSD(otherToken, event, protocolType)
      tokenDayData.openPriceUSD = token.id == trade.takerToken
        ? trade.makerTokenDeltaWei.div(trade.takerTokenDeltaWei).times(otherPriceUSD).truncate(36)
        : trade.takerTokenDeltaWei.div(trade.makerTokenDeltaWei).times(otherPriceUSD).truncate(36)
    }
  } else {
    tokenDayData.openPriceUSD = previousHourToken.closePriceUSD
  }

  tokenDayData.ammPriceUSD = ZERO_BD
  tokenDayData.highPriceUSD = tokenDayData.openPriceUSD
  tokenDayData.lowPriceUSD = tokenDayData.openPriceUSD
  tokenDayData.closePriceUSD = tokenDayData.openPriceUSD

  return tokenDayData
}

export function updateTokenDayDataForAmmEvent(token: Token, event: ethereum.Event): TokenDayData {
  let ethToken = Token.load(WETH_ADDRESS) as Token
  let ethPriceUSD = getTokenOraclePriceUSD(ethToken, event, ProtocolType.Amm)
  let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Amm)
  let dayId = getDayId(event.block.timestamp)
  let tokenDayID = `${token.id}-${dayId}`

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    setupTokenDayData(tokenDayData as TokenDayData, BigInt.fromString(dayId).toI32(), token, event, ProtocolType.Amm)
  }

  tokenDayData.ammPriceUSD = (token.derivedETH as BigDecimal).times(ethPriceUSD).truncate(18)
  tokenDayData.ammLiquidityToken = token.ammTradeLiquidity
  tokenDayData.ammLiquidityUSD = token.ammTradeLiquidity.times(tokenPriceUSD).truncate(18)
  tokenDayData.dailyAllTransactionCount = tokenDayData.dailyAllTransactionCount.plus(ONE_BI)
  tokenDayData.save()

  return tokenDayData as TokenDayData
}

export function updateAndReturnTokenHourDataForMarginEvent(token: Token, event: ethereum.Event): TokenHourData {
  let hourId = getHourId(event.block.timestamp)
  let tokenHourID = `${token.id}-${hourId}`

  let tokenHourData = TokenHourData.load(tokenHourID)
  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    setupTokenHourData(
      tokenHourData as TokenHourData,
      BigInt.fromString(hourId).toI32(),
      token,
      event,
      ProtocolType.Core,
    )

    let ethToken = Token.load(WETH_ADDRESS) as Token
    let ethPriceUSD = getTokenOraclePriceUSD(ethToken, event, ProtocolType.Core)
    let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)

    // Initialize the AMM data
    tokenHourData.ammPriceUSD = (token.derivedETH as BigDecimal).times(ethPriceUSD).truncate(18)
    tokenHourData.ammLiquidityToken = token.ammTradeLiquidity
    tokenHourData.ammLiquidityUSD = token.ammTradeLiquidity.times(tokenPriceUSD).truncate(18)
  }

  tokenHourData.borrowLiquidityToken = token.borrowLiquidity
  tokenHourData.supplyLiquidityToken = token.supplyLiquidity

  tokenHourData.borrowLiquidityUSD = token.borrowLiquidityUSD
  tokenHourData.supplyLiquidityUSD = token.supplyLiquidityUSD

  tokenHourData.hourlyAllTransactionCount = tokenHourData.hourlyAllTransactionCount.plus(ONE_BI)

  tokenHourData.save()

  return tokenHourData as TokenHourData
}

export function updateAndReturnTokenDayDataForMarginEvent(token: Token, event: ethereum.Event): TokenDayData {
  let dayId = getDayId(event.block.timestamp)
  let tokenDayID = `${token.id}-${dayId}`

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    setupTokenDayData(tokenDayData as TokenDayData, BigInt.fromString(dayId).toI32(), token, event, ProtocolType.Core)

    let ethToken = Token.load(WETH_ADDRESS) as Token
    let ethPriceUSD = getTokenOraclePriceUSD(ethToken, event, ProtocolType.Core)
    let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)

    // Initialize the AMM data
    tokenDayData.ammPriceUSD = (token.derivedETH as BigDecimal).times(ethPriceUSD).truncate(18)
    tokenDayData.ammLiquidityToken = token.ammTradeLiquidity
    tokenDayData.ammLiquidityUSD = token.ammTradeLiquidity.times(tokenPriceUSD).truncate(18)
  }

  tokenDayData.borrowLiquidityToken = token.borrowLiquidity
  tokenDayData.supplyLiquidityToken = token.supplyLiquidity

  tokenDayData.borrowLiquidityUSD = token.borrowLiquidityUSD
  tokenDayData.supplyLiquidityUSD = token.supplyLiquidityUSD

  tokenDayData.dailyAllTransactionCount = tokenDayData.dailyAllTransactionCount.plus(ONE_BI)

  tokenDayData.save()

  return tokenDayData as TokenDayData
}

export function updateTimeDataForBorrow(
  token: Token,
  event: ethereum.Event,
  borrowAmountToken: BigDecimal,
  borrowAmountUSD: BigDecimal,
): void {
  let hourId = getHourId(event.block.timestamp)
  let tokenHourData = TokenHourData.load(`${token.id}-${hourId}`) as TokenHourData

  let dayId = getDayId(event.block.timestamp)
  let tokenDayData = TokenDayData.load(`${token.id}-${dayId}`) as TokenDayData

  let dolomiteDayData = DolomiteDayData.load(dayId) as DolomiteDayData
  let dolomiteHourData = DolomiteHourData.load(hourId) as DolomiteHourData

  tokenHourData.hourlyBorrowVolumeToken = tokenHourData.hourlyBorrowVolumeToken.plus(borrowAmountToken)
  tokenHourData.hourlyBorrowVolumeUSD = tokenHourData.hourlyBorrowVolumeUSD.plus(borrowAmountUSD)
  tokenHourData.save()

  tokenDayData.dailyBorrowVolumeToken = tokenDayData.dailyBorrowVolumeToken.plus(borrowAmountToken)
  tokenDayData.dailyBorrowVolumeUSD = tokenDayData.dailyBorrowVolumeUSD.plus(borrowAmountUSD)
  tokenDayData.save()

  dolomiteDayData.dailyBorrowVolumeUSD = dolomiteDayData.dailyBorrowVolumeUSD.plus(borrowAmountUSD)
  dolomiteDayData.save()

  dolomiteHourData.hourlyBorrowVolumeUSD = dolomiteHourData.hourlyBorrowVolumeUSD.plus(borrowAmountUSD)
  dolomiteHourData.save()
}

export function updateTimeDataForTrade(
  dolomiteDayData: DolomiteDayData,
  dolomiteHourData: DolomiteHourData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  otherToken: Token,
  event: ethereum.Event,
  trade: Trade,
): void {
  if (tokenDayData.token != token.id || tokenHourData.token != token.id || token.id == otherToken.id) {
    log.error(
      'Invalid trade token for day data {} or hour data {} does not match token {}',
      [tokenDayData.token, tokenHourData.token, token.id],
    )
  }

  // Using the below examples of buying / selling, token == USD || token == ETH
  let oraclePriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
  let otherPriceUSD = getTokenOraclePriceUSD(otherToken, event, ProtocolType.Core)
  let closePriceUSD = token.id == trade.takerToken
    ? trade.makerTokenDeltaWei.div(trade.takerTokenDeltaWei).times(otherPriceUSD).truncate(36)
    : trade.takerTokenDeltaWei.div(trade.makerTokenDeltaWei).times(otherPriceUSD).truncate(36)

  // IE: BUY 4 ETH @ $300 --> outputDeltaWei = $1200; inputDeltaWei = 4 ETH; takerToken = USD; makerToken = ETH
  // IE: SELL 4 ETH @ $300 --> outputDeltaWei = 4 ETH; inputDeltaWei = $1200; takerToken = ETH; makerToken = USD
  if (trade.takerToken == token.id) {
    let amountUSD = trade.takerTokenDeltaWei.times(oraclePriceUSD).truncate(18)

    // we don't want to double count trade volume, so keep it with the taker token
    dolomiteDayData.dailyTradeVolumeUSD = dolomiteDayData.dailyTradeVolumeUSD.plus(amountUSD)
    dolomiteDayData.dailyTradeCount = dolomiteDayData.dailyTradeCount.plus(ONE_BI)

    dolomiteHourData.hourlyTradeVolumeUSD = dolomiteHourData.hourlyTradeVolumeUSD.plus(amountUSD)
    dolomiteHourData.hourlyTradeCount = dolomiteHourData.hourlyTradeCount.plus(ONE_BI)

    tokenDayData.dailyTradeVolumeToken = tokenDayData.dailyTradeVolumeToken.plus(trade.takerTokenDeltaWei)
    tokenDayData.dailyTradeVolumeUSD = tokenDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenHourData.hourlyTradeVolumeToken = tokenHourData.hourlyTradeVolumeToken.plus(trade.takerTokenDeltaWei)
    tokenHourData.hourlyTradeVolumeUSD = tokenHourData.hourlyTradeVolumeUSD.plus(amountUSD)
  } else {
    // trade.makerToken == token.id
    let amountUSD = trade.makerTokenDeltaWei.times(oraclePriceUSD).truncate(18)

    tokenDayData.dailyTradeVolumeToken = tokenDayData.dailyTradeVolumeToken.plus(trade.makerTokenDeltaWei)
    tokenDayData.dailyTradeVolumeUSD = tokenDayData.dailyTradeVolumeUSD.plus(amountUSD)

    tokenHourData.hourlyTradeVolumeToken = tokenHourData.hourlyTradeVolumeToken.plus(trade.makerTokenDeltaWei)
    tokenHourData.hourlyTradeVolumeUSD = tokenHourData.hourlyTradeVolumeUSD.plus(amountUSD)
  }

  tokenDayData.dailyTradeCount = tokenDayData.dailyTradeCount.plus(ONE_BI)
  tokenHourData.hourlyTradeCount = tokenHourData.hourlyTradeCount.plus(ONE_BI)

  if (tokenDayData.lowPriceUSD.gt(closePriceUSD) || tokenDayData.lowPriceUSD.equals(ZERO_BD)) {
    tokenDayData.lowPriceUSD = closePriceUSD
  }
  if (tokenHourData.lowPriceUSD.gt(closePriceUSD) || tokenHourData.lowPriceUSD.equals(ZERO_BD)) {
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
  dolomiteHourData.save()
}

export function updateTimeDataForLiquidation(
  dolomiteDayData: DolomiteDayData,
  dolomiteHourData: DolomiteHourData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  event: ethereum.Event,
  liquidation: Liquidation,
): void {
  if (tokenDayData.token != token.id || tokenHourData.token != token.id) {
    log.error(
      'Invalid liquidation token for day data {} or hour data {} does not match token {}',
      [tokenDayData.token, tokenHourData.token, token.id],
    )
  }

  if (liquidation.borrowedToken == token.id) {
    let liquidationVolumeToken = liquidation.borrowedTokenAmountDeltaWei

    let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
    let liquidationVolumeUSD = liquidationVolumeToken.times(tokenPriceUSD).truncate(18)

    tokenDayData.dailyLiquidationVolumeToken = tokenDayData.dailyLiquidationVolumeToken.plus(liquidationVolumeToken)
    tokenDayData.dailyLiquidationVolumeUSD = tokenDayData.dailyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    tokenDayData.dailyLiquidationCount = tokenDayData.dailyLiquidationCount.plus(ONE_BI)

    tokenHourData.hourlyLiquidationVolumeToken = tokenHourData.hourlyLiquidationVolumeToken.plus(liquidationVolumeToken)
    tokenHourData.hourlyLiquidationVolumeUSD = tokenHourData.hourlyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    tokenHourData.hourlyLiquidationCount = tokenHourData.hourlyLiquidationCount.plus(ONE_BI)

    dolomiteDayData.dailyLiquidationVolumeUSD = dolomiteDayData.dailyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    dolomiteDayData.dailyLiquidationCount = dolomiteDayData.dailyLiquidationCount.plus(ONE_BI)

    dolomiteHourData.hourlyLiquidationVolumeUSD = dolomiteHourData.hourlyLiquidationVolumeUSD.plus(liquidationVolumeUSD)
    dolomiteHourData.hourlyLiquidationCount = dolomiteHourData.hourlyLiquidationCount.plus(ONE_BI)

    tokenDayData.save()
    tokenHourData.save()
    dolomiteDayData.save()
    dolomiteHourData.save()
  }
}

export function updateTimeDataForVaporization(
  dolomiteDayData: DolomiteDayData,
  dolomiteHourData: DolomiteHourData,
  tokenDayData: TokenDayData,
  tokenHourData: TokenHourData,
  token: Token,
  event: ethereum.Event,
  vaporization: Vaporization,
): void {
  if (tokenDayData.token != token.id || tokenHourData.token != token.id) {
    log.error(
      'Invalid liquidation token for day data {} or hour data {} does not match token {}',
      [tokenDayData.token, tokenHourData.token, token.id],
    )
  }

  if (vaporization.borrowedToken == token.id) {
    let vaporizationVolumeToken = absBD(vaporization.borrowedTokenAmountDeltaWei)

    let tokenPriceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
    let vaporizationVolumeUSD = vaporizationVolumeToken.times(tokenPriceUSD).truncate(18)

    tokenDayData.dailyVaporizationVolumeToken = tokenDayData.dailyVaporizationVolumeToken.plus(vaporizationVolumeToken)
    tokenDayData.dailyVaporizationVolumeUSD = tokenDayData.dailyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    tokenDayData.dailyVaporizationCount = tokenDayData.dailyVaporizationCount.plus(ONE_BI)

    tokenHourData.hourlyVaporizationVolumeToken = tokenHourData.hourlyVaporizationVolumeToken.plus(
      vaporizationVolumeToken)
    tokenHourData.hourlyVaporizationVolumeUSD = tokenHourData.hourlyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    tokenHourData.hourlyVaporizationCount = tokenHourData.hourlyVaporizationCount.plus(ONE_BI)

    dolomiteDayData.dailyVaporizationVolumeUSD = dolomiteDayData.dailyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    dolomiteDayData.dailyVaporizationCount = dolomiteDayData.dailyVaporizationCount.plus(ONE_BI)

    dolomiteHourData.hourlyVaporizationVolumeUSD = dolomiteHourData.hourlyVaporizationVolumeUSD.plus(vaporizationVolumeUSD)
    dolomiteHourData.hourlyVaporizationCount = dolomiteHourData.hourlyVaporizationCount.plus(ONE_BI)

    tokenDayData.save()
    dolomiteDayData.save()
  }
}
