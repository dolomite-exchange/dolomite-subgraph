/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import { DolomiteMarginERC20 } from '../types/MarginAdmin/DolomiteMarginERC20'
import {
  AmmLiquidityPosition,
  AmmLiquidityPositionSnapshot,
  AmmPair,
  Bundle, DolomiteMargin,
  Token,
  TokenMarketIdReverseLookup,
  User,
} from '../types/schema'
import { ValueStruct } from './margin-types'
import {
  ZERO_BI,
  ZERO_BD,
  ONE_BI,
  DOLOMITE_MARGIN_ADDRESS,
  CHAIN_ID,
  isArbitrumGoerli,
  isArbitrumMainnet, USDC_ADDRESS,
} from './generated/constants'
import { IsolationModeVault } from '../types/templates'

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1')
  for (let i = ZERO_BI; i.lt(decimals); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'))
  }
  return bd
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals.equals(ZERO_BI)) {
    return tokenAmount.toBigDecimal()
  } else {
    return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
}

export function convertStructToDecimalAppliedValue(struct: ValueStruct, exchangeDecimals: BigInt): BigDecimal {
  let value = struct.sign ? struct.value : struct.value.neg()
  if (exchangeDecimals.equals(ZERO_BI)) {
    return ZERO_BD
  } else {
    return value.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
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

  let symbolValue = 'unknown'
  let symbolResult = contract.try_symbol()
  if (!symbolResult.reverted) {
    symbolValue = symbolResult.value
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

  let nameValue = 'unknown'
  let nameResult = contract.try_name()
  if (!nameResult.reverted) {
    nameValue = nameResult.value
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
  token.chainId = CHAIN_ID
  token.symbol = fetchTokenSymbol(tokenAddress)
  token.name = fetchTokenName(tokenAddress)
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
  token.ammTradeLiquidity = ZERO_BD
  token.borrowLiquidity = ZERO_BD
  token.borrowLiquidityUSD = ZERO_BD
  token.supplyLiquidity = ZERO_BD
  token.supplyLiquidityUSD = ZERO_BD
  token.transactionCount = ZERO_BI

  if (isArbitrumGoerli() && token.symbol == 'dPTSynInd') {
    // this token says it has 18 decimals on-chain but that's incorrect
    token.decimals = BigInt.fromI32(6)
  } else if (isArbitrumMainnet() && token.id == USDC_ADDRESS) {
    // this token says it has 18 decimals on-chain but that's incorrect
    token.name = "Bridged USDC"
    token.symbol = "USDC.e"
  }

  // dGLP doesn't have the "Dolomite Isolation:" prefix, so it's an edge-case
  let dGlpAddress = Address.fromString('0x34DF4E8062A8C8Ae97E3382B452bd7BF60542698')
  if (token.name.includes('Dolomite Isolation:') || Address.fromString(token.id).equals(dGlpAddress)) {
    IsolationModeVault.create(Address.fromString(token.id))
    token.isIsolationMode = true
  } else {
    token.isIsolationMode = false
  }

  token.save()

  let reverseMap = new TokenMarketIdReverseLookup(marketId.toString())
  reverseMap.token = token.id
  reverseMap.save()
}

export function createLiquidityPosition(exchange: Address, user: Address): AmmLiquidityPosition {
  let positionID = `${exchange.toHexString()}-${user.toHex()}`

  let liquidityTokenBalance = AmmLiquidityPosition.load(positionID)
  if (liquidityTokenBalance === null) {
    let pair = AmmPair.load(exchange.toHexString()) as AmmPair
    pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI)

    liquidityTokenBalance = new AmmLiquidityPosition(positionID)
    liquidityTokenBalance.liquidityTokenBalance = ZERO_BD
    liquidityTokenBalance.pair = exchange.toHexString()
    liquidityTokenBalance.user = user.toHexString()
    let user = User.load(liquidityTokenBalance.user) as User
    liquidityTokenBalance.effectiveUser = user.effectiveUser

    pair.save()
    liquidityTokenBalance.save()
  }

  return liquidityTokenBalance as AmmLiquidityPosition
}

export function createUserIfNecessary(address: Address): void {
  let user = User.load(address.toHexString())
  if (user === null) {
    user = new User(address.toHexString())
    user.effectiveUser = address.toHexString() // make it self-reflective for now until IsolationMode event fires
    user.totalUsdBorrowed = ZERO_BD
    user.totalUsdCollateralLiquidated = ZERO_BD
    user.totalUsdAmmTraded = ZERO_BD
    user.totalUsdTraded = ZERO_BD

    user.totalBorrowPositionCount = ZERO_BI
    user.totalLiquidationCount = ZERO_BI
    user.totalMarginPositionCount = ZERO_BI
    user.totalTradeCount = ZERO_BI
    user.save()

    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    dolomiteMargin.userCount = dolomiteMargin.userCount.plus(ONE_BI)
    dolomiteMargin.save()
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
  snapshot.save()
  position.save()
}
