import {
  Address,
  BigDecimal,
  BigInt,
  ethereum,
  log
} from '@graphprotocol/graph-ts'
import { DolomiteMargin as DolomiteMarginAdminProtocol } from '../../types/MarginAdmin/DolomiteMargin'
import { DolomiteMargin as DolomiteMarginCoreProtocol } from '../../types/MarginCore/DolomiteMargin'
import { DolomiteMargin as DolomiteMarginExpiryProtocol } from '../../types/MarginExpiry/DolomiteMargin'
import {
  DolomiteMargin as DolomiteMarginPositionProtocol,
  DolomiteMargin__getMarketPriceResultValue0Struct,
} from '../../types/DolomiteAmmRouter/DolomiteMargin'
import { DolomiteMargin as DolomiteMarginZapProtocol } from '../../types/Zap/DolomiteMargin'
import {
  AmmPair,
  AmmPairReverseLookup,
  Bundle,
  OraclePrice,
  Token,
  Trade
} from '../../types/schema'
import { DolomiteMargin as DolomiteMarginAmmProtocol } from '../../types/templates/AmmPair/DolomiteMargin'
import {
  DAI_WETH_PAIR,
  DOLOMITE_MARGIN_ADDRESS,
  ONE_BD,
  USDT_WETH_PAIR,
  WETH_ADDRESS,
  WETH_USDC_ADDRESS,
  WHITELIST,
  ZERO_BD,
} from '../generated/constants'
import { ProtocolType } from './margin-types'
import { convertTokenToDecimal } from './token-helpers'

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let daiPair = AmmPair.load(DAI_WETH_PAIR)
  let usdcPair = AmmPair.load(WETH_USDC_ADDRESS)
  let usdtPair = AmmPair.load(USDT_WETH_PAIR)

  let wethAddress = WETH_ADDRESS

  if (daiPair !== null && usdcPair !== null && usdtPair !== null) {
    // all 3 have been created
    let daiReserveETH = daiPair.token0 == wethAddress ? daiPair.reserve0 : daiPair.reserve1
    let usdcReserveETH = usdcPair.token0 == wethAddress ? usdcPair.reserve0 : usdcPair.reserve1
    let usdtReserveETH = usdtPair.token0 == wethAddress ? usdtPair.reserve0 : usdtPair.reserve1
    let totalLiquidityETH = daiReserveETH.plus(usdcReserveETH).plus(usdtReserveETH)

    if (totalLiquidityETH.equals(ZERO_BD)) {
      return ZERO_BD
    }

    let daiWeight = daiReserveETH.div(totalLiquidityETH)
    let usdcWeight = usdcReserveETH.div(totalLiquidityETH)
    let usdtWeight = usdtReserveETH.div(totalLiquidityETH)

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

    if (totalLiquidityETH.equals(ZERO_BD)) {
      return ZERO_BD
    }

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

function convertPriceToDecimal(rawPrice: BigInt, token: Token): BigDecimal {
  return convertTokenToDecimal(rawPrice, BigInt.fromI32(36 - token.decimals.toI32()))
}

export function getTokenOraclePriceUSD(token: Token, event: ethereum.Event, protocolType: string): BigDecimal {
  let oraclePrice = OraclePrice.load(token.id) as OraclePrice
  if (oraclePrice.blockHash.equals(event.block.hash)) {
    return oraclePrice.price
  } else {
    log.info(
      'Getting oracle price for block number {} with hash {} for token {}',
      [event.block.number.toString(), event.block.hash.toHexString(), token.id]
    )
    let price: BigDecimal
    if (protocolType == ProtocolType.Core) {
      let marginProtocol = DolomiteMarginCoreProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else if (protocolType == ProtocolType.Admin) {
      let marginProtocol = DolomiteMarginAdminProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else if (protocolType == ProtocolType.Expiry) {
      let marginProtocol = DolomiteMarginExpiryProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else if (protocolType == ProtocolType.Amm) {
      let marginProtocol = DolomiteMarginAmmProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else if (protocolType == ProtocolType.Position) {
      let marginProtocol = DolomiteMarginPositionProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else if (protocolType == ProtocolType.Position) {
      let marginProtocol = DolomiteMarginZapProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
      let call = marginProtocol.try_getMarketPrice(token.marketId)
      price = call.reverted ? oraclePrice.price : convertPriceToDecimal(call.value.value, token)
    } else {
      log.critical('Invalid protocol type, found {}', [protocolType])
      price = ZERO_BD
    }

    oraclePrice.price = price
    oraclePrice.blockHash = event.block.hash
    oraclePrice.blockNumber = event.block.number
    oraclePrice.save()

    return oraclePrice.price
  }
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
    let reverseLookup = AmmPairReverseLookup.load(token.id.concat('-')
      .concat(WHITELIST[i]))
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
    let takerToken = Token.load(trade.takerToken) as Token
    let takerTokenPrice = trade.takerTokenDeltaWei.div(trade.makerTokenDeltaWei)
    return takerTokenPrice.times(takerToken.derivedETH as BigDecimal) // return token1 per our token * ETH per token1
  } else {
    let makerToken = Token.load(trade.makerToken) as Token
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
  let bundle = Bundle.load('1') as Bundle
  let price0 = ZERO_BD
  if (token0.derivedETH) {
    price0 =  token0.derivedETH.times(bundle.ethPrice)
  }
  let price1 = ZERO_BD
  if (token1.derivedETH) {
    token1.derivedETH.times(bundle.ethPrice)
  }

  // if less than 5 LPs, require high minimum reserve amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    if (!price0 || !price1) {
      return ZERO_BD
    }

    let reserve0USD = pair.reserve0.times(price0)
    let reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD)
        .lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2'))
        .lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2'))
        .lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    if (!price0 || !price1) {
      return ZERO_BD
    }

    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    if (!price0) {
      return ZERO_BD
    }
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    if (!price1) {
      return ZERO_BD
    }
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
    return tokenAmount0.times(price0)
      .plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
      .times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
      .times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
