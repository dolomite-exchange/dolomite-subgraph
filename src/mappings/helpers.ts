/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt, Bytes, ethereum, log } from '@graphprotocol/graph-ts'
import { DolomiteMarginERC20 } from '../types/DolomiteMargin/DolomiteMarginERC20'
import {
  AmmLiquidityPosition,
  AmmLiquidityPositionSnapshot,
  AmmPair,
  Bundle,
  DolomiteMargin,
  InterestIndex,
  Token, TokenMarketIdReverseMap,
  User
} from '../types/schema'
import { ValueStruct } from './dolomite-margin-types'
import { getTokenOraclePriceUSD } from './pricing'
import {
  DolomiteMargin as DolomiteMarginProtocol,
  DolomiteMargin__getMarketTotalParResultValue0Struct as DolomiteMarginMarketTotalParStruct
} from '../types/DolomiteMargin/DolomiteMargin'

export let ZERO_BYTES = new Bytes(0)
export let ZERO_BI = BigInt.fromI32(0)
export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let ONE_BD = BigDecimal.fromString('1')
export let BI_10 = BigInt.fromI32(10)
export let BI_18 = BigInt.fromI32(18)
export let BI_ONE_ETH = BI_10.pow(18)
export let BD_ONE_ETH = new BigDecimal(BI_ONE_ETH)
export let SECONDS_IN_YEAR = BigInt.fromI32(31536000)

export function bigDecimalAbs(bd: BigDecimal): BigDecimal {
  if (bd.lt(ZERO_BD)) {
    return ZERO_BD.minus(bd)
  } else {
    return bd
  }
}

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1')
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'))
  }
  return bd
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal.fromString('1000000000000000000')
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  return eth.toBigDecimal().div(exponentToBigDecimal(BigInt.fromI32(18)))
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals.equals(ZERO_BI)) {
    return tokenAmount.toBigDecimal()
  } else {
    return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
}

export function convertStructToDecimal(struct: ValueStruct, exchangeDecimals: BigInt): BigDecimal {
  let value = struct.sign ? struct.value : struct.value.neg()
  if (exchangeDecimals.equals(ZERO_BI)) {
    return value.toBigDecimal()
  } else {
    return value.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString())
  const zero = parseFloat(ZERO_BD.toString())
  return zero == formattedVal
}

export function isNullEthValue(value: string): boolean {
  return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

export function fetchTokenSymbol(tokenAddress: Address): string {
  // hard coded overrides
  if (tokenAddress.toHexString() == '0xe0b7927c4af23765cb51314a0e0521a9645f0e2a') {
    return 'DGD'
  }
  if (tokenAddress.toHexString() == '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9') {
    return 'AAVE'
  }

  let contract = DolomiteMarginERC20.bind(tokenAddress)

  // try types string and bytes32 for symbol
  let symbolValue = 'unknown'
  let symbolResult = contract.try_symbol()
  if (symbolResult.reverted) {
    let symbolResultBytes = contract.try_symbol()
    if (!symbolResultBytes.reverted) {
      // for broken pairs that have no symbol function exposed
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
        symbolValue = symbolResultBytes.value.toString()
      }
    }
  } else {
    symbolValue = symbolResult.value.toString()
  }

  return symbolValue
}

export function fetchTokenName(tokenAddress: Address): string {
  // hard coded overrides
  if (tokenAddress.toHexString() == '0xe0b7927c4af23765cb51314a0e0521a9645f0e2a') {
    return 'DGD'
  }
  if (tokenAddress.toHexString() == '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9') {
    return 'Aave Token'
  }

  let contract = DolomiteMarginERC20.bind(tokenAddress)

  // try types string and bytes32 for name
  let nameValue = 'unknown'
  let nameResult = contract.try_name()
  if (nameResult.reverted) {
    let nameResultBytes = contract.try_name()
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString()
      }
    }
  } else {
    nameValue = nameResult.value.toString()
  }

  return nameValue
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  let contract = DolomiteMarginERC20.bind(tokenAddress)

  let totalSupplyResult = contract.try_totalSupply()
  if (!totalSupplyResult.reverted) {
    return totalSupplyResult.value
  } else {
    return BigInt.fromI32(0)
  }
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  // hardcode overrides
  const aaveToken = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'
  if (tokenAddress.toHexString() == aaveToken) {
    return BigInt.fromI32(18)
  }

  let contract = DolomiteMarginERC20.bind(tokenAddress)
  // try types uint8 for decimals
  let decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    return BigInt.fromI32(decimalResult.value)
  } else {
    return BigInt.fromI32(0)
  }
}

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

export function createLiquidityPosition(exchange: Address, user: Address): AmmLiquidityPosition {
  let positionID = exchange.toHexString() + '-' + user.toHex()

  let liquidityTokenBalance = AmmLiquidityPosition.load(positionID)
  if (liquidityTokenBalance === null) {
    let pair = AmmPair.load(exchange.toHexString()) as AmmPair
    pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI)

    liquidityTokenBalance = new AmmLiquidityPosition(positionID)
    liquidityTokenBalance.liquidityTokenBalance = ZERO_BD
    liquidityTokenBalance.pair = exchange.toHexString()
    liquidityTokenBalance.user = user.toHexString()

    pair.save()
    liquidityTokenBalance.save()
  }

  return liquidityTokenBalance as AmmLiquidityPosition
}

export function createUserIfNecessary(address: Address): void {
  let user = User.load(address.toHexString())
  if (user === null) {
    user = new User(address.toHexString())
    user.totalUsdBorrowed = ZERO_BD
    user.totalUsdLiquidated = ZERO_BD
    user.totalUsdSwapped = ZERO_BD
    user.totalUsdTraded = ZERO_BD
    user.save()
  }
}

export function absBD(bd: BigDecimal): BigDecimal {
  if (bd.lt(ZERO_BD)) {
    return bd.neg()
  } else {
    return bd
  }
}

export function absBI(bi: BigInt): BigInt {
  if (bi.lt(ZERO_BI)) {
    return bi.neg()
  } else {
    return bi
  }
}

export function createLiquiditySnapshot(position: AmmLiquidityPosition, event: ethereum.Event): void {
  let timestamp = event.block.timestamp.toI32()
  let bundle = Bundle.load('1') as Bundle
  let pair = AmmPair.load(position.pair) as AmmPair
  let token0 = Token.load(pair.token0) as Token
  let token1 = Token.load(pair.token1) as Token

  // create new snapshot
  let snapshot = new AmmLiquidityPositionSnapshot(position.id.concat(timestamp.toString()))
  snapshot.liquidityPosition = position.id
  snapshot.timestamp = timestamp
  snapshot.block = event.block.number.toI32()
  snapshot.user = position.user
  snapshot.pair = position.pair
  snapshot.token0PriceUSD = (token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  snapshot.token1PriceUSD = (token1.derivedETH as BigDecimal).times(bundle.ethPrice)
  snapshot.reserve0 = pair.reserve0
  snapshot.reserve1 = pair.reserve1
  snapshot.reserveUSD = pair.reserveUSD
  snapshot.liquidityTokenTotalSupply = pair.totalSupply
  snapshot.liquidityTokenBalance = position.liquidityTokenBalance
  snapshot.liquidityPosition = position.id
  snapshot.save()
  position.save()
}

export function weiToPar(wei: BigDecimal, index: InterestIndex, decimals: BigInt): BigDecimal {
  if (wei.ge(ZERO_BD)) {
    return wei.div(index.supplyIndex).truncate(decimals.toI32())
  } else {
    let smallestUnit = BigDecimal.fromString('1').div(new BigDecimal(BigInt.fromI32(10).pow(decimals.toI32() as u8)))
    return wei.div(index.borrowIndex).truncate(decimals.toI32()).minus(smallestUnit)
  }
}

export function parToWei(par: BigDecimal, index: InterestIndex): BigDecimal {
  let decimals: u8 = par.exp.lt(BigInt.fromI32(0)) ? par.exp.neg().toI32() as u8 : 0
  if (par.ge(ZERO_BD)) {
    return par.times(index.supplyIndex).truncate(decimals)
  } else {
    let oneWei = BigDecimal.fromString('1').div(new BigDecimal(BigInt.fromI32(10).pow(decimals)))
    return par.times(index.borrowIndex).truncate(decimals).minus(oneWei)
  }
}

function isRepaymentOfBorrowAmount(
  newPar: BigDecimal,
  deltaWei: BigDecimal,
  index: InterestIndex
): boolean {
  let newWei = parToWei(newPar, index)
  let oldWei = newWei.minus(deltaWei)
  return deltaWei.gt(ZERO_BD) && oldWei.lt(ZERO_BD) // the user added to the negative balance (decreasing it)
}

function getMarketTotalBorrowWei(
  value: DolomiteMarginMarketTotalParStruct,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals.toI32()
  return parToWei(convertTokenToDecimal(value.borrow.neg(), token.decimals), index).neg().truncate(decimals)
}

function getMarketTotalSupplyWei(
  value: DolomiteMarginMarketTotalParStruct,
  token: Token,
  index: InterestIndex
): BigDecimal {
  let decimals = token.decimals.toI32()
  return parToWei(convertTokenToDecimal(value.supply, token.decimals), index).truncate(decimals)
}

export function changeProtocolBalance(
  token: Token,
  newParStruct: ValueStruct,
  deltaWeiStruct: ValueStruct,
  index: InterestIndex,
  isVirtualTransfer: boolean,
  dolomiteMargin: DolomiteMargin,
  protocol: DolomiteMarginProtocol
): void {
  let tokenPriceUSD = getTokenOraclePriceUSD(token)

  let newPar = convertStructToDecimal(newParStruct, token.decimals)
  let newWei = parToWei(newPar, index)
  let deltaWei = convertStructToDecimal(deltaWeiStruct, token.decimals)

  let totalParStruct = protocol.getMarketTotalPar(token.marketId)

  if (newPar.lt(ZERO_BD) && deltaWei.lt(ZERO_BD)) {
    // the user borrowed funds

    let borrowVolumeToken = absBD(deltaWei)
    if (absBD(newWei) < absBD(deltaWei)) {
      // the user withdrew from a positive balance to a negative one. Range cap it by newWei for borrow volume
      borrowVolumeToken = absBD(newWei)
    }

    // temporarily get rid of the old USD liquidity
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)

    token.borrowLiquidity = getMarketTotalBorrowWei(totalParStruct, token, index)
    token.borrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD)
    dolomiteMargin.totalBorrowVolumeUSD = dolomiteMargin.totalBorrowVolumeUSD.plus(borrowVolumeToken.times(tokenPriceUSD))
  } else if (isRepaymentOfBorrowAmount(newPar, deltaWei, index)) {
    // temporarily get rid of the old USD liquidity
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD)

    token.borrowLiquidity = getMarketTotalBorrowWei(totalParStruct, token, index)
    token.borrowLiquidityUSD = token.borrowLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD)
  }

  if (!isVirtualTransfer) {
    // the balance change affected the ERC20.balanceOf(protocol)
    // temporarily get rid of the old USD liquidity
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

    token.supplyLiquidity = getMarketTotalSupplyWei(totalParStruct, token, index)
    token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD)

    if (deltaWei.gt(ZERO_BD)) {
      let deltaWeiUSD = deltaWei.times(tokenPriceUSD)
      dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deltaWeiUSD)
    }
  } else {
    // Adjust the liquidity of the protocol and token
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD)

    token.supplyLiquidityUSD = token.supplyLiquidity.times(tokenPriceUSD)

    // add the new liquidity back in
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD)
  }

  dolomiteMargin.save()
  token.save()
}
