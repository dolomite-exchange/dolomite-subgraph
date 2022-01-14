import { AmmPair, AmmPairReverseLookup, Bundle, OraclePrice, Token, Trade } from '../types/schema'
import { BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { ONE_BD, ZERO_BD } from './amm-helpers'
import { DAI_WETH_PAIR, USDT_WETH_PAIR, WETH_ADDRESS, WETH_USDC_ADDRESS, WHITELIST } from './generated/constants'

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let daiPair = AmmPair.load(DAI_WETH_PAIR) // dai is token0
  let usdcPair = AmmPair.load(WETH_USDC_ADDRESS) // usdc is token0
  let usdtPair = AmmPair.load(USDT_WETH_PAIR) // usdt is token1

  let wethAddress = WETH_ADDRESS

  if (daiPair !== null && usdcPair !== null && usdtPair !== null) {
    // all 3 have been created
    let daiReserveETH = daiPair.token0 == wethAddress ? daiPair.reserve0 : daiPair.reserve1
    let usdcReserveETH = usdcPair.token0 == wethAddress ? usdcPair.reserve0 : usdcPair.reserve1
    let usdtReserveETH = usdtPair.token0 == wethAddress ? usdtPair.reserve0 : usdtPair.reserve1
    let totalLiquidityETH = daiReserveETH.plus(usdcReserveETH).plus(usdtReserveETH)

    let daiReserveStable = daiPair.token0 == wethAddress ? daiPair.reserve1 : daiPair.reserve0
    let usdcReserveStable = usdcPair.token0 == wethAddress ? usdcPair.reserve1 : usdcPair.reserve0
    let usdtReserveStable = usdtPair.token0 == wethAddress ? usdtPair.reserve1 : usdtPair.reserve0

    let daiWeight = daiReserveStable.div(totalLiquidityETH)
    let usdcWeight = usdcReserveStable.div(totalLiquidityETH)
    let usdtWeight = usdtReserveStable.div(totalLiquidityETH)

    let daiPrice = daiPair.token0 == wethAddress ? daiPair.token1Price : daiPair.token0Price
    let usdcPrice = usdcPair.token0 == wethAddress ? usdcPair.token1Price : usdcPair.token0Price
    let usdtPrice = usdtPair.token0 == wethAddress ? usdtPair.token1Price : usdtPair.token0Price

    return daiPrice.times(daiWeight)
      .plus(usdcPrice.times(usdcWeight))
      .plus(usdtPrice.times(usdtWeight))
  } else if (daiPair !== null && usdcPair !== null) {
    // dai and USDC have been created
    let daiReserveETH = daiPair.token0 == wethAddress ? daiPair.reserve0 : daiPair.reserve1
    let usdcReserveETH = usdcPair.token0 == wethAddress ? usdcPair.reserve0 : usdcPair.reserve1
    let totalLiquidityETH = daiReserveETH.plus(usdcReserveETH)

    let daiWeight = daiReserveETH.div(totalLiquidityETH)
    let usdcWeight = usdcReserveETH.div(totalLiquidityETH)

    let daiPrice = daiPair.token0 == wethAddress ? daiPair.token1Price : daiPair.token0Price
    let usdcPrice = usdcPair.token0 == wethAddress ? usdcPair.token1Price : usdcPair.token0Price

    return daiPrice.times(daiWeight)
      .plus(usdcPrice.times(usdcWeight))
  } else if (usdcPair !== null) {
    // USDC is the only pair so far
    return usdcPair.token0 == wethAddress ? usdcPair.token1Price : usdcPair.token0Price
  } else {
    return ZERO_BD
  }
}

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
let MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('10000')

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_ETH = BigDecimal.fromString('2')

export function getTokenOraclePriceUSD(token: Token): BigDecimal {
  return (OraclePrice.load(token.marketId.toString()) as OraclePrice).price
}

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD
  }

  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; i += 1) {
    let reverseLookup = AmmPairReverseLookup.load(token.id.concat('-').concat(WHITELIST[i]))
    if (reverseLookup !== null) {
      let pair = AmmPair.load(reverseLookup.pair) as AmmPair
      if (pair.token0 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token1 = Token.load(pair.token1) as Token
        return pair.token1Price.times(token1.derivedETH as BigDecimal) // return token1 per our token * Eth per token 1
      } else if (pair.token1 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token0 = Token.load(pair.token0) as Token
        return pair.token0Price.times(token0.derivedETH as BigDecimal) // return token0 per our token * ETH per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

export function findETHPerTokenForTrade(trade: Trade, token: Token): BigDecimal {
  if (token.id == trade.makerToken) {
    let takerToken = Token.load(trade.takerToken)
    let takerTokenPrice = trade.takerTokenDeltaWei.div(trade.makerTokenDeltaWei)
    return takerTokenPrice.times(takerToken.derivedETH as BigDecimal) // return token1 per our token * ETH per token1
  } else {
    let makerToken = Token.load(trade.makerToken)
    let makerTokenPrice = trade.makerTokenDeltaWei.div(trade.takerTokenDeltaWei)
    return makerTokenPrice.times(makerToken.derivedETH as BigDecimal) // return token0 per our token * ETH per token0
  }
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: AmmPair
): BigDecimal {
  let bundle = Bundle.load('1')
  let price0 = token0.derivedETH.times(bundle.ethPrice)
  let price1 = token1.derivedETH.times(bundle.ethPrice)

  // if less than 5 LPs, require high minimum reserve amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0)
    let reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load('1') as Bundle
  let price0 = (token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  let price1 = (token1.derivedETH as BigDecimal).times(bundle.ethPrice)

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
