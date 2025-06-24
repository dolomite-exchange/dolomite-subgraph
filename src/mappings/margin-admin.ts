/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Address, BigDecimal, BigInt, Bytes, log, store } from '@graphprotocol/graph-ts'
import {
  DolomiteMargin as DolomiteMarginProtocol,
  LogAddMarket as AddMarketEvent,
  LogRemoveMarket as RemoveMarketEvent,
  LogSetAccountMaxNumberOfMarketsWithBalances as MaxNumberOfMarketsWithBalancesAndDebtUpdateEvent,
  LogSetAccountRiskOverrideSetter as AccountRiskOverrideSetterUpdateEvent,
  LogSetAutoTraderIsSpecial as AutoTraderIsSpecialUpdateEvent,
  LogSetCallbackGasLimit as CallbackGasLimitUpdateEvent,
  LogSetDefaultAccountRiskOverrideSetter as DefaultAccountRiskOverrideSetterUpdateEvent,
  LogSetEarningsRate as EarningsRateUpdateEvent,
  LogSetEarningsRateOverride as EarningsRateOverrideUpdateEvent,
  LogSetGlobalOperator as GlobalOperatorUpdateEvent,
  LogSetInterestSetter as InterestSetterUpdateEvent,
  LogSetIsClosing as IsClosingUpdateEvent,
  LogSetLiquidationSpread as LiquidationSpreadUpdateEvent,
  LogSetLiquidationSpreadPremium as LiquidationSpreadPremiumUpdateEvent,
  LogSetMarginPremium as MarginPremiumUpdateEvent,
  LogSetMarginRatio as MarginRatioUpdateEvent,
  LogSetMaxBorrowWei as MaxBorrowWeiUpdateEvent,
  LogSetMaxSupplyWei as MaxSupplyWeiUpdateEvent,
  LogSetMaxWei as MaxWeiUpdateEvent,
  LogSetMinBorrowedValue as MinBorrowedValueUpdateEvent,
  LogSetOracleSentinel as OracleSentinelUpdateEvent,
  LogSetPriceOracle as PriceOracleUpdateEvent,
  LogSetSpreadPremium as SpreadPremiumUpdateEvent,
} from '../types/MarginAdmin/DolomiteMargin'
import {
  DolomiteMargin,
  GlobalOperator,
  InterestIndex,
  InterestRate,
  MarketRiskInfo,
  OraclePrice,
  SpecialAutoTrader,
  Token,
  TokenMarketIdReverseLookup,
  TotalPar,
} from '../types/schema'
import {
  _18_BI,
  ADDRESS_ZERO,
  ARB_ADDRESS,
  DOLOMITE_MARGIN_ADDRESS,
  EXPIRY_ADDRESS,
  GOARB_VESTER_PROXY_ADDRESS,
  GRAI_ADDRESS,
  INTEREST_PRECISION,
  isArbitrumOne,
  OARB_VESTER_PROXY_ADDRESS,
  ONE_BD,
  ONE_ETH_BD,
  ZERO_BD,
  ZERO_BI,
} from './generated/constants'
import { getOrCreateDolomiteMarginForCall } from './helpers/margin-helpers'
import { ProtocolType } from './helpers/margin-types'
import {
  getLowerOptimalRate,
  getOptimalUtilizationRate,
  getUpperOptimalRate,
  updateInterestRate,
} from './interest-setter'
import { convertTokenToDecimal, initializeToken } from './helpers/token-helpers'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import { createUserIfNecessary } from './helpers/user-helpers'
import { DolomiteMarginExpiry } from '../types/MarginAdmin/DolomiteMarginExpiry'
import { initializeDolomiteMargin } from './helpers/initialize-dolomite-margin'
import { createLiquidityMiningVester } from './helpers/liquidity-mining-helpers'

export function handleMarketAdded(event: AddMarketEvent): void {
  log.info(
    'Adding market[{}] for token {} for hash and index: {}-{}',
    [
      event.params.marketId.toString(),
      event.params.token.toHexString(),
      event.transaction.hash.toHexString(),
      event.logIndex.toString(),
    ],
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.numberOfMarkets = marginProtocol.getNumMarkets().toI32()
  dolomiteMargin.save()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [tokenAddress])
    token = new Token(tokenAddress)
    initializeToken(token, event.params.marketId)
  }

  if (event.params.marketId.equals(ZERO_BI)) {
    // Crappy workaround since these initializations were created before the event emitters
    initializeDolomiteMargin()
  }
  if (isArbitrumOne()) {
    if (event.params.token.equals(Address.fromString(ARB_ADDRESS))) {
      createLiquidityMiningVester(Address.fromString(OARB_VESTER_PROXY_ADDRESS))
    } else if (event.params.token.equals(Address.fromString(GRAI_ADDRESS))) {
      createLiquidityMiningVester(Address.fromString(GOARB_VESTER_PROXY_ADDRESS))
    }
  }

  let index = new InterestIndex(token.id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.token = token.id
  index.save()

  let interestRate = new InterestRate(token.id)
  interestRate.borrowInterestRate = ZERO_BD
  interestRate.supplyInterestRate = ZERO_BD
  interestRate.interestSetter = Address.fromString(ADDRESS_ZERO)
  interestRate.optimalUtilizationRate = ZERO_BI
  interestRate.lowerOptimalRate = ZERO_BI
  interestRate.upperOptimalRate = ZERO_BI
  interestRate.token = token.id
  interestRate.save()

  let riskInfo = new MarketRiskInfo(token.id)
  riskInfo.token = token.id
  riskInfo.liquidationRewardPremium = ZERO_BD
  riskInfo.marginPremium = ZERO_BD
  riskInfo.isBorrowingDisabled = false
  riskInfo.oracle = Bytes.empty()
  riskInfo.supplyMaxWei = ZERO_BD
  riskInfo.save()

  let oraclePrice = new OraclePrice(token.id)
  oraclePrice.price = convertTokenToDecimal(
    marginProtocol.getMarketPrice(event.params.marketId).value,
    BigInt.fromI32(36 - token.decimals.toI32()),
  )
  oraclePrice.blockNumber = event.block.number
  oraclePrice.blockHash = event.block.hash
  oraclePrice.token = token.id
  oraclePrice.save()

  let totalPar = new TotalPar(token.id)
  totalPar.token = token.id
  totalPar.borrowPar = ZERO_BD
  totalPar.supplyPar = ZERO_BD
  totalPar.save()
}

export function handleMarketRemoved(event: RemoveMarketEvent): void {
  log.info(
    'Removing market[{}] for token {} for hash and index: {}-{}',
    [
      event.params.marketId.toString(),
      event.params.token.toHexString(),
      event.transaction.hash.toHexString(),
      event.logIndex.toString(),
    ],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.numberOfMarkets += 1
  dolomiteMargin.save()

  let id = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  store.remove('TokenMarketIdReverseLookup', id)
  store.remove('InterestIndex', id)
  store.remove('InterestRate', id)
  store.remove('MarketRiskInfo', id)
  store.remove('OraclePrice', id)
  store.remove('TotalPar', id)
}

export function handleSetIsMarketClosing(event: IsClosingUpdateEvent): void {
  log.info(
    'Handling set_market_closing for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  marketInfo.isBorrowingDisabled = event.params.isClosing
  marketInfo.save()
}

export function handleSetPriceOracle(event: PriceOracleUpdateEvent): void {
  log.info(
    'Handling price oracle change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  marketInfo.oracle = event.params.priceOracle
  marketInfo.save()
}

export function handleSetInterestSetter(event: InterestSetterUpdateEvent): void {
  log.info(
    'Handling interest setter change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let interestRate = InterestRate.load(token.id) as InterestRate
  interestRate.interestSetter = event.params.interestSetter

  interestRate.optimalUtilizationRate = getOptimalUtilizationRate(event.params.marketId, event.params.interestSetter)
  interestRate.lowerOptimalRate = getLowerOptimalRate(event.params.marketId, event.params.interestSetter)
  interestRate.upperOptimalRate = getUpperOptimalRate(event.params.marketId, event.params.interestSetter)
  interestRate.save()

  let totalPar = TotalPar.load(token.id) as TotalPar
  let index = InterestIndex.load(token.id) as InterestIndex
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  updateInterestRate(token, totalPar, index, dolomiteMargin)
}

export function handleSetMarginPremium(event: MarginPremiumUpdateEvent): void {
  log.info(
    'Handling margin premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  let marginPremium = new BigDecimal(event.params.marginPremium.value)
  marketInfo.marginPremium = marginPremium.div(ONE_ETH_BD)
  marketInfo.save()
}

export function handleSetLiquidationSpreadPremium(event: SpreadPremiumUpdateEvent): void {
  log.info(
    'Handling liquidation spread premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  let spreadPremium = new BigDecimal(event.params.spreadPremium.value)
  marketInfo.liquidationRewardPremium = spreadPremium.div(ONE_ETH_BD)
  marketInfo.save()
}

export function handleSetLiquidationSpreadPremiumV2(event: LiquidationSpreadPremiumUpdateEvent): void {
  log.info(
    'Handling liquidation spread premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  let spreadPremium = new BigDecimal(event.params.liquidationSpreadPremium.value)
  marketInfo.liquidationRewardPremium = spreadPremium.div(ONE_ETH_BD)
  marketInfo.save()
}

export function handleSetMaxSupplyWei(event: MaxWeiUpdateEvent): void {
  log.info(
    'Handling max wei change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  if (event.params.maxWei.value.equals(ZERO_BI)) {
    marketInfo.supplyMaxWei = null
  } else {
    marketInfo.supplyMaxWei = convertTokenToDecimal(event.params.maxWei.value, token.decimals)
  }
  marketInfo.save()
}

export function handleSetMaxSupplyWeiV2(event: MaxSupplyWeiUpdateEvent): void {
  log.info(
    'Handling max wei change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  if (event.params.maxSupplyWei.value.equals(ZERO_BI)) {
    marketInfo.supplyMaxWei = null
  } else {
    marketInfo.supplyMaxWei = convertTokenToDecimal(event.params.maxSupplyWei.value, token.decimals)
  }
  marketInfo.save()
}

export function handleSetMaxBorrowWei(event: MaxBorrowWeiUpdateEvent): void {
  log.info(
    'Handling max wei change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  if (event.params.maxBorrowWei.value.equals(ZERO_BI)) {
    marketInfo.borrowMaxWei = null
  } else {
    marketInfo.borrowMaxWei = convertTokenToDecimal(event.params.maxBorrowWei.value, token.decimals)
  }
  marketInfo.save()
}

export function handleSetEarningsRateOverride(event: EarningsRateOverrideUpdateEvent): void {
  log.info(
    'Handling max wei change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  if (event.params.earningsRateOverride.value.equals(ZERO_BI)) {
    marketInfo.earningsRateOverride = null
  } else {
    marketInfo.earningsRateOverride = convertTokenToDecimal(event.params.earningsRateOverride.value, _18_BI)
  }
  marketInfo.save()
}

export function handleMarginRatioUpdate(event: MarginRatioUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let liquidationRatioBD = new BigDecimal(event.params.marginRatio.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
    .plus(ONE_BD)
  dolomiteMargin.save()
}

export function handleLiquidationSpreadUpdate(event: LiquidationSpreadUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let liquidationPremiumBD = new BigDecimal(event.params.liquidationSpread.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.liquidationReward = liquidationPremiumBD.div(ONE_ETH_BD)
    .plus(ONE_BD)
  dolomiteMargin.save()
}

export function handleEarningsRateUpdate(event: EarningsRateUpdateEvent): void {
  log.info(
    'Handling earnings rate change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  let adj = ONE_BD
  let oldEarningsRate = dolomiteMargin.earningsRate
  if (oldEarningsRate.gt(ZERO_BD)) {
    adj = oldEarningsRate
  }

  let earningsRateBD = new BigDecimal(event.params.earningsRate.value)
  dolomiteMargin.earningsRate = earningsRateBD.div(ONE_ETH_BD) // it's a ratio where ONE_ETH is 100%
  dolomiteMargin.save()

  let numberOfMarkets = dolomiteMargin.numberOfMarkets
  for (let i = 0; i < numberOfMarkets; i++) {
    let map = TokenMarketIdReverseLookup.load(i.toString()) // can be null for recycled markets
    if (map !== null) {
      let interestRate = InterestRate.load(map.token) as InterestRate
      // First undo the OLD supply interest rate by dividing by the old earnings rate,
      // THEN multiply by the new earnings rate to get the NEW supply rate
      interestRate.supplyInterestRate = interestRate.supplyInterestRate
        .div(adj)
        .truncate(INTEREST_PRECISION)
        .times(dolomiteMargin.earningsRate)
        .truncate(INTEREST_PRECISION)
      interestRate.save()
    }
  }
}

export function handleSetMinBorrowedValue(event: MinBorrowedValueUpdateEvent): void {
  log.info(
    'Handling min borrowed value change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let minBorrowedValueBD = new BigDecimal(event.params.minBorrowedValue.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
    .div(ONE_ETH_BD)
  dolomiteMargin.save()
}

export function handleSetMaxNumberOfMarketsWithBalances(
  event: MaxNumberOfMarketsWithBalancesAndDebtUpdateEvent,
): void {
  log.info(
    'Handling max # of markets with balances and debt change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.accountMaxNumberOfMarketsWithBalances = event.params.accountMaxNumberOfMarketsWithBalances
  dolomiteMargin.save()
}

export function handleSetOracleSentinel(event: OracleSentinelUpdateEvent): void {
  log.info(
    'Handling oracle sentinel change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.oracleSentinel = event.params.oracleSentinel
  dolomiteMargin.save()
}

export function handleSetCallbackGasLimit(event: CallbackGasLimitUpdateEvent): void {
  log.info(
    'Handling callback gas limit change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.callbackGasLimit = event.params.callbackGasLimit
  dolomiteMargin.save()
}

export function handleSetDefaultAccountRiskOverrideSetter(event: DefaultAccountRiskOverrideSetterUpdateEvent): void {
  log.info(
    'Handling default account risk override setter change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  if (event.params.defaultAccountRiskOverrideSetter.equals(Address.fromString(ADDRESS_ZERO))) {
    dolomiteMargin.defaultAccountRiskOverrideSetter = null
  } else {
    dolomiteMargin.defaultAccountRiskOverrideSetter = event.params.defaultAccountRiskOverrideSetter
  }
  dolomiteMargin.save()
}

export function handleSetAccountRiskOverrideSetter(event: AccountRiskOverrideSetterUpdateEvent): void {
  log.info(
    'Handling account risk override setter change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  createUserIfNecessary(event.params.accountOwner)
  let user = getEffectiveUserForAddress(event.params.accountOwner)
  if (event.params.accountRiskOverrideSetter.equals(Address.fromString(ADDRESS_ZERO))) {
    user.accountRiskOverrideSetter = null
  } else {
    user.accountRiskOverrideSetter = event.params.accountRiskOverrideSetter
  }
  user.save()
}

export function handleSetGlobalOperator(event: GlobalOperatorUpdateEvent): void {
  log.info(
    'Handling global operator change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  if (!event.params.approved) {
    store.remove('GlobalOperator', event.params.operator.toHexString())
  } else {
    let globalOperator = GlobalOperator.load(event.params.operator.toHexString())
    if (globalOperator === null) {
      globalOperator = new GlobalOperator(event.params.operator.toHexString())
      globalOperator.save()
    }
  }
}

export function handleSetAutoTraderIsSpecial(event: AutoTraderIsSpecialUpdateEvent): void {
  log.info(
    'Handling special auto trader change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  if (!event.params.isSpecial) {
    store.remove('SpecialAutoTrader', event.params.autoTrader.toHexString())
  } else {
    let autoTrader = SpecialAutoTrader.load(event.params.autoTrader.toHexString())
    if (autoTrader === null) {
      autoTrader = new SpecialAutoTrader(event.params.autoTrader.toHexString())
      autoTrader.save()
    }
    if (autoTrader.id == EXPIRY_ADDRESS) {
      let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
      let expiryProtocol = DolomiteMarginExpiry.bind(Address.fromString(EXPIRY_ADDRESS))
      dolomiteMargin.expiryRampTime = expiryProtocol.g_expiryRampTime()
      dolomiteMargin.save()
    }
  }
}
