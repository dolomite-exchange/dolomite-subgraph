import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'
import { DolomiteMarginERC20 } from '../../types/MarginAdmin/DolomiteMarginERC20'
import { Token, TokenMarketIdReverseLookup } from '../../types/schema'
import {
  CHAIN_ID,
  isArbitrumGoerli,
  isArbitrumMainnet,
  TEN_BI,
  USDC_ADDRESS,
  ZERO_BD,
  ZERO_BI,
} from '../generated/constants'
import { IsolationModeVault } from '../../types/templates'

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals.equals(ZERO_BI)) {
    return tokenAmount.toBigDecimal()
  } else {
    let base = new BigDecimal(TEN_BI.pow(exchangeDecimals.toI32() as u8))
    return tokenAmount.toBigDecimal().div(base)
  }
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
    token.name = 'Bridged USDC'
    token.symbol = 'USDC.e'
  }

  // dfsGLP doesn't have the "Dolomite Isolation:" prefix, so it's an edge-case
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
