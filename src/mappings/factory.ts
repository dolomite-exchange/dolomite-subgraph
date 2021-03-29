/* eslint-disable prefer-const */
import { log } from '@graphprotocol/graph-ts'
import { AmmFactory, AmmPair, Token, Bundle } from '../types/schema'
import { PairCreated } from '../types/UniswapV2Factory/Factory'
import { Pair as PairTemplate } from '../types/templates'
import {
  FACTORY_ADDRESS,
  ZERO_BD,
  ZERO_BI,
  fetchTokenSymbol,
  fetchTokenName,
  fetchTokenDecimals,
  fetchTokenTotalSupply
} from './helpers'

function initializeToken(token: Token, event: PairCreated): void {
  token.symbol = fetchTokenSymbol(event.params.token0)
  token.name = fetchTokenName(event.params.token0)
  token.totalSupply = fetchTokenTotalSupply(event.params.token0)
  let decimals = fetchTokenDecimals(event.params.token0)
  // bail if we couldn't figure out the decimals
  if (decimals === null) {
    log.debug('the decimal on token was null', [])
    return
  }

  token.decimals = decimals
  token.derivedETH = ZERO_BD
  token.tradeVolume = ZERO_BD
  token.tradeVolumeUSD = ZERO_BD
  token.untrackedVolumeUSD = ZERO_BD
  token.ammSwapLiquidity = ZERO_BD
  token.borrowedLiquidity = ZERO_BD
  token.borrowedLiquidityUSD = ZERO_BD
  token.suppliedLiquidity = ZERO_BD
  token.suppliedLiquidityUSD = ZERO_BD
  token.transactionCount = ZERO_BI
}

export function handleNewPair(event: PairCreated): void {
  // load factory (create if first exchange)
  let factory = AmmFactory.load(FACTORY_ADDRESS)
  if (factory === null) {
    factory = new AmmFactory(FACTORY_ADDRESS)
    factory.pairCount = 0
    factory.totalAmmVolumeETH = ZERO_BD
    factory.ammLiquidityETH = ZERO_BD
    factory.totalAmmVolumeUSD = ZERO_BD
    factory.untrackedAmmVolumeUSD = ZERO_BD
    factory.ammLiquidityUSD = ZERO_BD
    factory.transactionCount = ZERO_BI
    factory.swapCount = ZERO_BI

    // create new bundle
    let bundle = new Bundle('1')
    bundle.ethPrice = ZERO_BD
    bundle.save()
  }
  factory.pairCount = factory.pairCount + 1
  factory.save()

  // create the tokens
  let token0 = Token.load(event.params.token0.toHexString())
  let token1 = Token.load(event.params.token1.toHexString())

  // fetch info if null
  if (token0 === null) {
    token0 = new Token(event.params.token0.toHexString())
    initializeToken(token0, event)
  }

  // fetch info if null
  if (token1 === null) {
    token1 = new Token(event.params.token1.toHexString())
    initializeToken(token1, event)
  }

  const pair = new AmmPair(event.params.pair.toHexString())
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

  // save updated values
  token0.save()
  token1.save()
  pair.save()
  factory.save()
}
