// noinspection JSUnusedGlobalSymbols

import {
  BigDecimal,
  BigInt,
  Bytes,
  dataSource,
  TypedMap,
} from '@graphprotocol/graph-ts'

export const MAINNET_NETWORK = 'mainnet'
export const MUMBAI_NETWORK = 'mumbai'
export const ARBITRUM_GOERLI_NETWORK = 'arbitrum-goerli'
export const ARBITRUM_MAINNET_NETWORK = 'arbitrum-one'

export const ZERO_BYTES = Bytes.empty()

export const ZERO_BI = BigInt.fromI32(0)

export const ONE_BI = BigInt.fromI32(1)

export const ZERO_BD = BigDecimal.fromString('0')

export const ONE_BD = BigDecimal.fromString('1')

export const FIVE_BD = BigDecimal.fromString('5')

export const TEN_BI = BigInt.fromI32(10)

export const _100_BI = BigInt.fromI32(100)

export const _18_BI = BigInt.fromI32(18)

export const ONE_ETH_BI = TEN_BI.pow(18)

export const INTEREST_PRECISION = 18

export const USD_PRECISION = 18

export const ONE_ETH_BD = new BigDecimal(ONE_ETH_BI)

export const SECONDS_IN_YEAR = BigInt.fromI32(31536000)

export const NETWORK = dataSource.network()

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'.toLowerCase()

// ========================= Interest Setter Contract Addresses =========================

export const DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS = '{{doubleExponentV1InterestSetter}}'.toLowerCase()
export const AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS = '{{aaveAltCoinCopyCatV1InterestSetter}}'.toLowerCase()
export const AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS = '{{aaveStableCoinCopyCatV1InterestSetter}}'.toLowerCase()
export const ALWAYS_ZERO_INTEREST_SETTER_ADDRESS = '{{alwaysZeroInterestSetter}}'.toLowerCase()

// ========================= Protocol Contract Addresses =========================

export const BORROW_POSITION_PROXY_V1_ADDRESS = '{{borrowPositionProxyV1Address}}'.toLowerCase()

export const BORROW_POSITION_PROXY_V2_ADDRESS = '{{borrowPositionProxyV2Address}}'.toLowerCase()

export const DOLOMITE_AMM_ROUTER_PROXY_V1_ADDRESS = '{{dolomiteAmmRouterProxyV1Address}}'.toLowerCase()

export const DOLOMITE_AMM_ROUTER_PROXY_V2_ADDRESS = '{{dolomiteAmmRouterProxyV2Address}}'.toLowerCase()

export const DOLOMITE_MARGIN_ADDRESS = '{{dolomiteMarginAddress}}'.toLowerCase()

export const EVENT_EMITTER_PROXY_ADDRESS = '{{eventEmitterRegistryAddress}}'.toLowerCase()

export const EXPIRY_ADDRESS = '{{expiryAddress}}'.toLowerCase()

export const FACTORY_ADDRESS = '{{dolomiteAmmFactoryAddress}}'.toLowerCase()

export const LIQUIDITY_MINING_VESTER_PROXY_ADDRESS = '{{liquidityMiningVesterAddress}}'.toLowerCase()

export const MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS = '{{magicGlpUnwrapperTraderAddress}}'.toLowerCase()

export const MAGIC_GLP_WRAPPER_TRADER_ADDRESS = '{{magicGlpWrapperTraderAddress}}'.toLowerCase()

// ========================= Token Addresses =========================

export const ARB_ADDRESS = '{{arbAddress}}'.toLowerCase()

export const DAI_ADDRESS = '{{daiAddress}}'.toLowerCase()

export const LINK_ADDRESS = '{{linkAddress}}'.toLowerCase()

export const USDC_ADDRESS = '{{usdcAddress}}'.toLowerCase()

export const USDT_ADDRESS = '{{usdtAddress}}'.toLowerCase()

export const WBTC_ADDRESS = '{{wbtcAddress}}'.toLowerCase()

export const WETH_ADDRESS = '{{wethAddress}}'.toLowerCase()

export const WETH_USDC_ADDRESS = '{{wethUsdcAddress}}'.toLowerCase()

export const MATIC_ADDRESS = '{{maticAddress}}'.toLowerCase()

export const DAI_WETH_PAIR = '{{wethDaiAddress}}'.toLowerCase()

export const USDT_WETH_PAIR = '{{wethUsdtAddress}}'.toLowerCase()

export const CHAIN_IDS: TypedMap<string, BigInt> = new TypedMap<string, BigInt>()
CHAIN_IDS.set(MAINNET_NETWORK, BigInt.fromI32(1))
CHAIN_IDS.set(MUMBAI_NETWORK, BigInt.fromI32(80001))
CHAIN_IDS.set(ARBITRUM_GOERLI_NETWORK, BigInt.fromI32(421613))
CHAIN_IDS.set(ARBITRUM_MAINNET_NETWORK, BigInt.fromI32(42161))

const WHITELISTS: TypedMap<string, string[]> = new TypedMap<string, string[]>()
WHITELISTS.set(MAINNET_NETWORK, [
  // token where amounts should contribute to tracked volume and liquidity
  WETH_ADDRESS,
  USDC_ADDRESS,
  DAI_ADDRESS,
  MATIC_ADDRESS,
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x0000000000085d4780b73119b644ae5ecd22b376', // TUSD
  '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643', // cDAI
  '0x39aa39c021dfbae8fac545936693ac917d5e7563', // cUSDC
  '0x86fadb80d8d2cff3c3680819e4da99c10232ba0f', // EBASE
  '0x57ab1ec28d129707052df4df418d58a2d46d5f51', // sUSD
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
  '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
  '0x514910771af9ca656af840dff83e8264ecf986ca', // LINK
  '0x960b236a07cf122663c4303350609a66a7b288c0', // ANT
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e', // YFI
  '0xdf5e0e81dff6faf3a7e52ba697820c5e32d806a8' // yCurv
])
WHITELISTS.set(MUMBAI_NETWORK, [
  WETH_ADDRESS,
  USDC_ADDRESS,
  DAI_ADDRESS,
  MATIC_ADDRESS
])
WHITELISTS.set(ARBITRUM_MAINNET_NETWORK, [
  WETH_ADDRESS,
  USDC_ADDRESS,
  USDT_ADDRESS,
  DAI_ADDRESS,
  WBTC_ADDRESS,
  LINK_ADDRESS,
])
WHITELISTS.set(ARBITRUM_GOERLI_NETWORK, [
  WETH_ADDRESS,
  USDC_ADDRESS,
  DAI_ADDRESS,
  WBTC_ADDRESS,
  LINK_ADDRESS,
])
export const WHITELIST: string[] = WHITELISTS.get(NETWORK) as string[]

export const CHAIN_ID: i32 = (CHAIN_IDS.get(NETWORK) as BigInt).toI32()

if (WHITELIST.filter(value => value.toLowerCase() == ADDRESS_ZERO || value.length == 0).length > 0) {
  throw new Error('Invalid item found in whitelist!')
}

export function isArbitrumGoerli(): boolean {
  return NETWORK == ARBITRUM_GOERLI_NETWORK
}

export function isArbitrumMainnet(): boolean {
  return NETWORK == ARBITRUM_MAINNET_NETWORK
}
