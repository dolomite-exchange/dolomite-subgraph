import {
  AmmFactory,
  AmmPair,
  AmmPairDayData,
  AmmPairHourData,
  Bundle,
  DolomiteDayData,
  Token,
  TokenDayData
} from '../types/schema'
/* eslint-disable prefer-const */
import { BigDecimal, BigInt, EthereumEvent } from '@graphprotocol/graph-ts'
import { FACTORY_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from './helpers'

export function updateDolomiteDayData(event: EthereumEvent): DolomiteDayData {
  const factory = AmmFactory.load(FACTORY_ADDRESS)
  const timestamp = event.block.timestamp.toI32()
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400

  let dolomiteDayData = DolomiteDayData.load(dayID.toString())
  if (dolomiteDayData === null) {
    dolomiteDayData = new DolomiteDayData(dayID.toString())
    dolomiteDayData.date = dayStartTimestamp

    dolomiteDayData.allDailyVolumeUSD = ZERO_BD
    dolomiteDayData.allDailyVolumeETH = ZERO_BD

    dolomiteDayData.swapDailyVolumeETH = ZERO_BD
    dolomiteDayData.swapDailyVolumeUSD = ZERO_BD
    dolomiteDayData.swapDailyVolumeUntracked = ZERO_BD
    dolomiteDayData.swapTransacionCount = factory.transactionCount

    dolomiteDayData.totalVolumeUSD = ZERO_BD
    dolomiteDayData.totalVolumeETH = ZERO_BD
  }

  const previousDayData = DolomiteDayData.load((dayID - 1).toString())

  // dolomiteDayData.totalAmmLiquidityUSD = factory.totalLiquidityUSD
  // dolomiteDayData.totalAmmLiquidityETH = factory.totalLiquidityETH

  dolomiteDayData.totalVolumeETH = factory.totalAmmVolumeETH
  dolomiteDayData.totalAmmLiquidityETH = factory.totalAmmLiquidityETH
  dolomiteDayData.totalMarginLiquidityETH = factory.totalMarginLiquidityETH
  dolomiteDayData.totalAmmLiquidityUSD = factory.totalAmmLiquidityUSD
  dolomiteDayData.totalVolumeUSD = factory.totalAmmVolumeUSD
  dolomiteDayData.totalMarginLiquidityUSD = factory.totalMarginLiquidityUSD
  dolomiteDayData.totalLiquidationVolumeUSD = factory.totalLiquidationVolumeUSD
  dolomiteDayData.totalVaporizationVolumeUSD = factory.totalVaporizationVolumeUSD

  dolomiteDayData.transactionCount = previousDayData?.transactionCount || ZERO_BI
  dolomiteDayData.save()

  return dolomiteDayData as DolomiteDayData
}

export function updatePairDayData(event: EthereumEvent): AmmPairDayData {
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let dayPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())
  let pair = AmmPair.load(event.address.toHexString())
  let pairDayData = AmmPairDayData.load(dayPairID)
  if (pairDayData === null) {
    pairDayData = new AmmPairDayData(dayPairID)
    pairDayData.date = dayStartTimestamp
    pairDayData.token0 = pair.token0
    pairDayData.token1 = pair.token1
    pairDayData.pairAddress = event.address
    pairDayData.dailyVolumeToken0 = ZERO_BD
    pairDayData.dailyVolumeToken1 = ZERO_BD
    pairDayData.dailyVolumeUSD = ZERO_BD
    pairDayData.dailyTxns = ZERO_BI
  }

  pairDayData.totalSupply = pair.totalSupply
  pairDayData.reserve0 = pair.reserve0
  pairDayData.reserve1 = pair.reserve1
  pairDayData.reserveUSD = pair.reserveUSD
  pairDayData.dailyTxns = pairDayData.dailyTxns.plus(ONE_BI)
  pairDayData.save()

  return pairDayData as AmmPairDayData
}

export function updatePairHourData(event: EthereumEvent): AmmPairHourData {
  let timestamp = event.block.timestamp.toI32()
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  let hourPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(hourIndex).toString())
  let pair = AmmPair.load(event.address.toHexString())
  let pairHourData = AmmPairHourData.load(hourPairID)
  if (pairHourData === null) {
    pairHourData = new AmmPairHourData(hourPairID)
    pairHourData.hourStartUnix = hourStartUnix
    pairHourData.pair = event.address.toHexString()
    pairHourData.hourlyVolumeToken0 = ZERO_BD
    pairHourData.hourlyVolumeToken1 = ZERO_BD
    pairHourData.hourlyVolumeUSD = ZERO_BD
    pairHourData.hourlyTxns = ZERO_BI
  }

  pairHourData.reserve0 = pair.reserve0
  pairHourData.reserve1 = pair.reserve1
  pairHourData.reserveUSD = pair.reserveUSD
  pairHourData.hourlyTxns = pairHourData.hourlyTxns.plus(ONE_BI)
  pairHourData.save()

  return pairHourData as AmmPairHourData
}

export function updateTokenDayData(token: Token, event: EthereumEvent): TokenDayData {
  let bundle = Bundle.load('1')
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let tokenDayID = token.id
    .toString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    tokenDayData.date = dayStartTimestamp
    tokenDayData.token = token.id
    tokenDayData.priceUSD = token.derivedETH.times(bundle.ethPrice)
    tokenDayData.dailyVolumeToken = ZERO_BD
    tokenDayData.dailyVolumeETH = ZERO_BD
    tokenDayData.dailyVolumeUSD = ZERO_BD
    tokenDayData.dailyTxns = ZERO_BI
    tokenDayData.totalLiquidityUSD = ZERO_BD
  }
  tokenDayData.priceUSD = token.derivedETH.times(bundle.ethPrice)
  tokenDayData.totalLiquidityToken = token.totalLiquidity
  tokenDayData.totalLiquidityETH = token.totalLiquidity.times(token.derivedETH as BigDecimal)
  tokenDayData.totalLiquidityUSD = tokenDayData.totalLiquidityETH.times(bundle.ethPrice)
  tokenDayData.dailyTxns = tokenDayData.dailyTxns.plus(ONE_BI)
  tokenDayData.save()

  /**
   * @todo test if this speeds up sync
   */
  // updateStoredTokens(tokenDayData as TokenDayData, dayID)
  // updateStoredPairs(tokenDayData as TokenDayData, dayPairID)

  return tokenDayData as TokenDayData
}
