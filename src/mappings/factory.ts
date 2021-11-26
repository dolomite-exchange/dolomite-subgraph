/* eslint-disable prefer-const */
import { log, Address, BigInt } from '@graphprotocol/graph-ts'
import { AmmFactory, AmmPair, Token, Bundle, AmmPairReverseLookup, TokenMarketIdReverseMap } from '../types/schema'
import { PairCreated } from '../types/UniswapV2Factory/UniswapV2Factory'
import { AmmPair as PairTemplate } from '../types/templates'
import {
  FACTORY_ADDRESS,
  ZERO_BD,
  ZERO_BI,
  fetchTokenSymbol,
  fetchTokenName,
  fetchTokenDecimals,
  fetchTokenTotalSupply,
  SOLO_MARGIN_ADDRESS
} from './helpers'
import { DyDx } from '../types/MarginTrade/DyDx'

export function initializeToken(token: Token, marketId: BigInt): void {
  let tokenAddress = Address.fromString(token.id)
  token.symbol = fetchTokenSymbol(tokenAddress)
  token.name = fetchTokenName(tokenAddress)
  token.totalSupply = fetchTokenTotalSupply(tokenAddress)
  let decimals = fetchTokenDecimals(tokenAddress)
  // bail if we couldn't figure out the decimals
  if (decimals === null) {
    log.debug('the decimal on token was null', [])
    return
  }

  token.decimals = decimals
  token.marketId = marketId
  token.derivedETH = ZERO_BD
  token.tradeVolume = ZERO_BD
  token.tradeVolumeUSD = ZERO_BD
  token.untrackedVolumeUSD = ZERO_BD
  token.ammSwapLiquidity = ZERO_BD
  token.borrowLiquidity = ZERO_BD
  token.borrowLiquidityUSD = ZERO_BD
  token.supplyLiquidity = ZERO_BD
  token.supplyLiquidityUSD = ZERO_BD
  token.transactionCount = ZERO_BI

  let reverseMap = new TokenMarketIdReverseMap(marketId.toString())
  reverseMap.tokenAddress = token.id
  reverseMap.save()
}

export function handleNewPair(event: PairCreated): void {
  let factoryAddress = FACTORY_ADDRESS
  if (event.address.toHexString() != factoryAddress) {
    log.error('Invalid Factory address, found {} and {}', [event.address.toHexString(), factoryAddress])
    throw new Error()
  }

  // load factory (create if first exchange)
  let factory = AmmFactory.load(factoryAddress)
  if (factory === null) {
    factory = new AmmFactory(factoryAddress)
    factory.pairCount = 0
    factory.totalAmmVolumeUSD = ZERO_BD
    factory.untrackedAmmVolumeUSD = ZERO_BD
    factory.ammLiquidityUSD = ZERO_BD
    factory.transactionCount = ZERO_BI
    factory.swapCount = ZERO_BI

    // create new bundle
    let bundle = new Bundle('1')
    bundle.ethPrice = ZERO_BD
    bundle.priceOracleLastUpdatedBlockHash = event.block.hash.toHexString()
    bundle.save()
  }
  factory.pairCount = factory.pairCount + 1
  factory.save()

  // create the tokens
  let token0 = Token.load(event.params.token0.toHexString())
  let token1 = Token.load(event.params.token1.toHexString())

  let dydx = DyDx.bind(Address.fromString(SOLO_MARGIN_ADDRESS))

  // fetch info if null
  if (token0 === null) {
    let tokenAddress = event.params.token0.toHexString()
    token0 = new Token(tokenAddress)
    initializeToken(token0 as Token, dydx.getMarketIdByTokenAddress(Address.fromString(tokenAddress)))
  }

  // fetch info if null
  if (token1 === null) {
    let tokenAddress = event.params.token1.toHexString()
    token1 = new Token(tokenAddress)
    initializeToken(token1 as Token, dydx.getMarketIdByTokenAddress(Address.fromString(tokenAddress)))
  }

  let pair = new AmmPair(event.params.pair.toHexString())
  pair.token0 = token0.id
  pair.token1 = token1.id
  pair.liquidityProviderCount = ZERO_BI
  pair.createdAtTimestamp = event.block.timestamp
  pair.createdAtBlockNumber = event.block.number
  pair.transactionCount = ZERO_BI
  pair.reserve0 = ZERO_BD
  pair.reserve1 = ZERO_BD
  pair.trackedReserveETH = ZERO_BD
  pair.reserveETH = ZERO_BD
  pair.reserveUSD = ZERO_BD
  pair.totalSupply = ZERO_BD
  pair.volumeToken0 = ZERO_BD
  pair.volumeToken1 = ZERO_BD
  pair.volumeUSD = ZERO_BD
  pair.untrackedVolumeUSD = ZERO_BD
  pair.token0Price = ZERO_BD
  pair.token1Price = ZERO_BD

  // create the tracked contract based on the template
  PairTemplate.create(event.params.pair)

  let reverseLookup1 = new AmmPairReverseLookup(token0.id.concat('-').concat(token1.id))
  reverseLookup1.pair = pair.id

  let reverseLookup2 = new AmmPairReverseLookup(token1.id.concat('-').concat(token0.id))
  reverseLookup2.pair = pair.id

  // save updated values
  token0.save()
  token1.save()
  pair.save()
  reverseLookup1.save()
  reverseLookup2.save()
  factory.save()
}
