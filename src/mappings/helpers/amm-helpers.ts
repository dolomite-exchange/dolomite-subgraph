/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import {
  AmmLiquidityPosition,
  AmmLiquidityPositionSnapshot,
  AmmPair,
  Bundle,
  InterestIndex,
  Token,
  User,
} from '../../types/schema'
import { ValueStruct } from './margin-types'
import { ONE_BI, TEN_BI, ZERO_BD, ZERO_BI } from '../generated/constants'
import { getOrCreateInterestIndexSnapshotAndReturnId } from './helpers'

export function convertStructToDecimalAppliedValue(struct: ValueStruct, exchangeDecimals: BigInt): BigDecimal {
  let value = struct.sign ? struct.value : struct.value.neg()
  if (exchangeDecimals.equals(ZERO_BI)) {
    return ZERO_BD
  } else {
    let base = new BigDecimal(TEN_BI.pow(exchangeDecimals.toI32() as u8))
    return value.toBigDecimal().div(base)
  }
}

export function createLiquidityPosition(exchange: Address, userAddress: Address): AmmLiquidityPosition {
  let positionID = `${exchange.toHexString()}-${userAddress.toHexString()}`

  let liquidityTokenBalance = AmmLiquidityPosition.load(positionID)
  if (liquidityTokenBalance === null) {
    let pair = AmmPair.load(exchange.toHexString()) as AmmPair
    pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI)

    liquidityTokenBalance = new AmmLiquidityPosition(positionID)
    liquidityTokenBalance.liquidityTokenBalance = ZERO_BD
    liquidityTokenBalance.pair = exchange.toHexString()
    liquidityTokenBalance.user = userAddress.toHexString()
    let user = User.load(liquidityTokenBalance.user) as User
    liquidityTokenBalance.effectiveUser = user.effectiveUser

    pair.save()
    liquidityTokenBalance.save()
  }

  return liquidityTokenBalance as AmmLiquidityPosition
}

export function createLiquiditySnapshot(
  position: AmmLiquidityPosition,
  event: ethereum.Event,
): void {
  let timestamp = event.block.timestamp.toI32()
  let bundle = Bundle.load('1') as Bundle
  let pair = AmmPair.load(position.pair) as AmmPair
  let token0 = Token.load(pair.token0) as Token
  let token1 = Token.load(pair.token1) as Token
  let token0MarketIndex = InterestIndex.load(token0.id) as InterestIndex
  let token1MarketIndex = InterestIndex.load(token1.id) as InterestIndex

  // create new snapshot
  let snapshot = new AmmLiquidityPositionSnapshot(`${position.id}${timestamp.toString()}`)
  snapshot.liquidityPosition = position.id
  snapshot.timestamp = timestamp
  snapshot.block = event.block.number.toI32()
  snapshot.user = position.user
  snapshot.effectiveUser = position.effectiveUser
  snapshot.pair = position.pair
  snapshot.token0PriceUSD = (token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  snapshot.token1PriceUSD = (token1.derivedETH as BigDecimal).times(bundle.ethPrice)
  snapshot.reserve0 = pair.reserve0
  snapshot.reserve1 = pair.reserve1
  snapshot.reserveUSD = pair.reserveUSD
  snapshot.liquidityTokenTotalSupply = pair.totalSupply
  snapshot.liquidityTokenBalance = position.liquidityTokenBalance
  snapshot.liquidityPosition = position.id
  snapshot.token0InterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(token0MarketIndex)
  snapshot.token1InterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(token1MarketIndex)
  snapshot.save()
  position.save()
}
