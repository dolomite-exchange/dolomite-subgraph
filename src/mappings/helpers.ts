/* eslint-disable prefer-const */
import { BigInt, BigDecimal, Address, EthereumEvent } from '@graphprotocol/graph-ts'
import { ERC20 } from '../types/UniswapV2Factory/ERC20'
import { ERC20SymbolBytes } from '../types/UniswapV2Factory/ERC20SymbolBytes'
import { ERC20NameBytes } from '../types/UniswapV2Factory/ERC20NameBytes'
import { User, Bundle, Token, AmmLiquidityPosition, AmmLiquidityPositionSnapshot, AmmPair } from '../types/schema'
import { Factory as FactoryContract } from '../types/templates/Pair/Factory'
import { ValueStruct } from './dydx_types'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
export const FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'

export let ZERO_BI = BigInt.fromI32(0)
export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let ONE_BD = BigDecimal.fromString('1')
export let BI_18 = BigInt.fromI32(18)
export let BI_ONE_ETH = BigInt.fromI32(10).pow(18)

export let factoryContract = FactoryContract.bind(Address.fromString(FACTORY_ADDRESS))

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
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal()
  } else {
    return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
}

export function convertStructToDecimal(struct: ValueStruct, exchangeDecimals: BigInt): BigDecimal {
  const value = struct.sign ? struct.value : ZERO_BI.minus(struct.value)
  if (exchangeDecimals == ZERO_BI) {
    return value.toBigDecimal()
  } else {
    return value.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
  }
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString())
  const zero = parseFloat(ZERO_BD.toString())
  return zero == formattedVal;
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

  let contract = ERC20.bind(tokenAddress)
  let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress)

  // try types string and bytes32 for symbol
  let symbolValue = 'unknown'
  let symbolResult = contract.try_symbol()
  if (symbolResult.reverted) {
    let symbolResultBytes = contractSymbolBytes.try_symbol()
    if (!symbolResultBytes.reverted) {
      // for broken pairs that have no symbol function exposed
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
        symbolValue = symbolResultBytes.value.toString()
      }
    }
  } else {
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

  let contract = ERC20.bind(tokenAddress)
  let contractNameBytes = ERC20NameBytes.bind(tokenAddress)

  // try types string and bytes32 for name
  let nameValue = 'unknown'
  let nameResult = contract.try_name()
  if (nameResult.reverted) {
    let nameResultBytes = contractNameBytes.try_name()
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString()
      }
    }
  } else {
    nameValue = nameResult.value
  }

  return nameValue
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  const contract = ERC20.bind(tokenAddress)

  const totalSupplyResult = contract.try_totalSupply()
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

  const contract = ERC20.bind(tokenAddress)
  // try types uint8 for decimals
  const decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    return decimalResult.value
  } else {
    return BigInt.fromI32(0)
  }
}

export function createLiquidityPosition(exchange: Address, user: Address): AmmLiquidityPosition {
  const positionID = `${exchange.toHexString()}-${user.toHex()}`

  let liquidityTokenBalance = AmmLiquidityPosition.load(positionID)
  if (liquidityTokenBalance === null) {
    const pair = AmmPair.load(exchange.toHexString())
    pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI)

    liquidityTokenBalance = new AmmLiquidityPosition(positionID)
    liquidityTokenBalance.liquidityTokenBalance = ZERO_BD
    liquidityTokenBalance.pair = exchange.toHexString()
    liquidityTokenBalance.user = user.toHexString()

    pair.save()
    liquidityTokenBalance.save()
  }

  return liquidityTokenBalance
}

export function createUser(address: Address): void {
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

export function createLiquiditySnapshot(position: AmmLiquidityPosition, event: EthereumEvent): void {
  const timestamp = event.block.timestamp.toI32()
  const bundle = Bundle.load('1')
  const pair = AmmPair.load(position.pair)
  const token0 = Token.load(pair.token0)
  const token1 = Token.load(pair.token1)

  // create new snapshot
  const snapshot = new AmmLiquidityPositionSnapshot(position.id.concat(timestamp.toString()))
  snapshot.liquidityPosition = position.id
  snapshot.timestamp = timestamp
  snapshot.block = event.block.number.toI32()
  snapshot.user = position.user
  snapshot.pair = position.pair
  snapshot.token0PriceUSD = token0.derivedETH.times(bundle.ethPrice)
  snapshot.token1PriceUSD = token1.derivedETH.times(bundle.ethPrice)
  snapshot.reserve0 = pair.reserve0
  snapshot.reserve1 = pair.reserve1
  snapshot.reserveUSD = pair.reserveUSD
  snapshot.liquidityTokenTotalSupply = pair.totalSupply
  snapshot.liquidityTokenBalance = position.liquidityTokenBalance
  snapshot.liquidityPosition = position.id
  snapshot.save()
  position.save()
}
