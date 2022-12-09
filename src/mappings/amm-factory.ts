/* eslint-disable prefer-const */
import { log } from '@graphprotocol/graph-ts'
import { PairCreated } from '../types/AmmFactory/DolomiteAmmFactory'
import {
  AmmFactory,
  AmmPair,
  AmmPairReverseLookup,
  Bundle,
  Token
} from '../types/schema'
import { AmmPair as PairTemplate } from '../types/templates'
import {
  FACTORY_ADDRESS,
  ZERO_BD,
  ZERO_BI
} from './generated/constants'

// noinspection JSUnusedGlobalSymbols
export function handleNewPair(event: PairCreated): void {
  let factoryAddress = FACTORY_ADDRESS
  if (event.address.toHexString() != factoryAddress) {
    log.error('Invalid Factory address, found {} and {}', [event.address.toHexString(), factoryAddress])
    return
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
    factory.ammTradeCount = ZERO_BI

    // create new bundle
    let bundle = new Bundle('1')
    bundle.ethPrice = ZERO_BD
    bundle.save()
  }
  factory.pairCount += 1
  factory.save()

  // create the tokens
  let token0 = Token.load(event.params.token0.toHexString()) as Token
  let token1 = Token.load(event.params.token1.toHexString()) as Token

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

  let reverseLookup1 = new AmmPairReverseLookup(token0.id.concat('-')
    .concat(token1.id))
  reverseLookup1.pair = pair.id

  let reverseLookup2 = new AmmPairReverseLookup(token1.id.concat('-')
    .concat(token0.id))
  reverseLookup2.pair = pair.id

  // save updated values
  token0.save()
  token1.save()
  pair.save()
  reverseLookup1.save()
  reverseLookup2.save()
  factory.save()
}
