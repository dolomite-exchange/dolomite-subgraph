// noinspection JSUnusedGlobalSymbols

import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  dataSource,
  TypedMap,
} from '@graphprotocol/graph-ts'

export const ARBITRUM_NETWORK = 'arbitrum'
export const ARBITRUM_ONE_NETWORK = 'arbitrum-one'
export const BASE_NETWORK = 'base'
export const BERACHAIN_NETWORK = 'berachain'
export const BERACHAIN_MAINNET_NETWORK = 'berachain-mainnet'
export const BOTANIX_NETWORK = 'botanix'
export const ETHEREUM_NETWORK = 'ethereum'
export const ETHEREUM_MAINNET_NETWORK = 'mainnet'
export const MANTLE_NETWORK = 'mantle'
export const POLYGON_ZKEVM_NETWORK = 'polygon-zkevm'
export const X_LAYER_NETWORK = 'xlayer'
export const X_LAYER_MAINNET_NETWORK = 'xlayer-mainnet'

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

export const AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS = '{{aaveAltCoinCopyCatV1InterestSetter}}'.toLowerCase()
export const AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS = '{{aaveStableCoinCopyCatV1InterestSetter}}'.toLowerCase()
export const ALWAYS_ZERO_INTEREST_SETTER_ADDRESS = '{{alwaysZeroInterestSetter}}'.toLowerCase()
export const DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS = '{{doubleExponentV1InterestSetter}}'.toLowerCase()
export const MODULAR_LINEAR_STEP_INTEREST_SETTER_ADDRESS = '{{modularLinearStepFunctionInterestSetter}}'.toLowerCase()

// ========================= Protocol Contract Addresses =========================

export const BORROW_POSITION_PROXY_V1_ADDRESS = '{{borrowPositionProxyV1Address}}'.toLowerCase()

export const BORROW_POSITION_PROXY_V2_ADDRESS = '{{borrowPositionProxyV2Address}}'.toLowerCase()

export const DOLOMITE_AMM_ROUTER_PROXY_V1_ADDRESS = '{{dolomiteAmmRouterProxyV1Address}}'.toLowerCase()

export const DOLOMITE_AMM_ROUTER_PROXY_V2_ADDRESS = '{{dolomiteAmmRouterProxyV2Address}}'.toLowerCase()

export const DOLOMITE_MARGIN_ADDRESS = '{{dolomiteMarginAddress}}'.toLowerCase()

export const EVENT_EMITTER_PROXY_ADDRESS = '{{eventEmitterRegistryAddress}}'.toLowerCase()

export const EVENT_EMITTER_FROM_CORE_ADDRESS = '{{eventEmitterRegistryFromCoreAddress}}'.toLowerCase()

export const EXPIRY_ADDRESS = '{{expiryAddress}}'.toLowerCase()

export const FACTORY_ADDRESS = '{{dolomiteAmmFactoryAddress}}'.toLowerCase()

export const GENERIC_TRADER_PROXY_V1 = '{{genericTraderProxyV1Address}}'.toLowerCase()

export const LIQUIDITY_MINING_VESTER_PROXY_ADDRESS = '{{liquidityMiningVesterAddress}}'.toLowerCase()

export const MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS = '{{magicGlpUnwrapperTraderAddress}}'.toLowerCase()

export const MAGIC_GLP_WRAPPER_TRADER_ADDRESS = '{{magicGlpWrapperTraderAddress}}'.toLowerCase()

export const GOARB_VESTER_PROXY_ADDRESS = '{{goArbLiquidityMiningVesterAddress}}'.toLowerCase()

export const OARB_VESTER_PROXY_ADDRESS = '{{oArbLiquidityMiningVesterAddress}}'.toLowerCase()

export const GOARB_TOKEN_ADDRESS = Address.fromHexString('0xC5e16f5009776aB645d6719B72962892428b2ac2')

export const OARB_TOKEN_ADDRESS = Address.fromHexString('0xCBED801b4162bf2A19B06968663438b5165A6A93')

// ========================= Token Addresses =========================

export const ARB_ADDRESS = '{{arbAddress}}'.toLowerCase()

export const DAI_ADDRESS = '{{daiAddress}}'.toLowerCase()

export const GRAI_ADDRESS = '{{graiAddress}}'.toLowerCase()

export const LINK_ADDRESS = '{{linkAddress}}'.toLowerCase()

export const USDC_ADDRESS = '{{usdcAddress}}'.toLowerCase()

export const USDT_ADDRESS = '{{usdtAddress}}'.toLowerCase()

export const WBTC_ADDRESS = '{{wbtcAddress}}'.toLowerCase()

export const WETH_ADDRESS = '{{wethAddress}}'.toLowerCase()

export const WETH_USDC_ADDRESS = '{{wethUsdcAddress}}'.toLowerCase()

export const MATIC_ADDRESS = '{{maticAddress}}'.toLowerCase()

export const DAI_WETH_PAIR = '{{wethDaiAddress}}'.toLowerCase()

export const USDT_WETH_PAIR = '{{wethUsdtAddress}}'.toLowerCase()

const CHAIN_IDS: TypedMap<string, BigInt> = new TypedMap<string, BigInt>()
CHAIN_IDS.set(ARBITRUM_NETWORK, BigInt.fromI32(42161))
CHAIN_IDS.set(ARBITRUM_ONE_NETWORK, BigInt.fromI32(42161))
CHAIN_IDS.set(BASE_NETWORK, BigInt.fromI32(8453))
CHAIN_IDS.set(BERACHAIN_NETWORK, BigInt.fromI32(80094))
CHAIN_IDS.set(BERACHAIN_MAINNET_NETWORK, BigInt.fromI32(80094))
CHAIN_IDS.set(BOTANIX_NETWORK, BigInt.fromI32(3637))
CHAIN_IDS.set(ETHEREUM_NETWORK, BigInt.fromI32(1))
CHAIN_IDS.set(ETHEREUM_MAINNET_NETWORK, BigInt.fromI32(1))
CHAIN_IDS.set(MANTLE_NETWORK, BigInt.fromI32(5000))
CHAIN_IDS.set(POLYGON_ZKEVM_NETWORK, BigInt.fromI32(1101))
CHAIN_IDS.set(X_LAYER_NETWORK, BigInt.fromI32(196))
CHAIN_IDS.set(X_LAYER_MAINNET_NETWORK, BigInt.fromI32(196))

const WHITELISTS: TypedMap<string, string[]> = new TypedMap<string, string[]>()
WHITELISTS.set(ARBITRUM_NETWORK, [
    WETH_ADDRESS,
    USDC_ADDRESS,
    USDT_ADDRESS,
    DAI_ADDRESS,
    WBTC_ADDRESS,
    LINK_ADDRESS,
  ]
)
WHITELISTS.set(ARBITRUM_ONE_NETWORK, WHITELISTS.get(ARBITRUM_NETWORK) as string[])
export const WHITELIST: string[] = WHITELISTS.get(NETWORK) !== null ? WHITELISTS.mustGet(NETWORK) : []

export const CHAIN_ID: i32 = (CHAIN_IDS.get(NETWORK) as BigInt).toI32()

if (WHITELIST.filter(value => value.toLowerCase() == ADDRESS_ZERO || value.length == 0).length > 0) {
  throw new Error('Invalid item found in whitelist!')
}

export function isArbitrumOne(): boolean {
  return NETWORK == ARBITRUM_NETWORK || NETWORK == ARBITRUM_ONE_NETWORK
}

export function isMantle(): boolean {
  return NETWORK == MANTLE_NETWORK
}

export function isPolygonZkEvm(): boolean {
  return NETWORK == POLYGON_ZKEVM_NETWORK
}

export function isXLayer(): boolean {
  return NETWORK == X_LAYER_NETWORK || NETWORK == X_LAYER_MAINNET_NETWORK
}
