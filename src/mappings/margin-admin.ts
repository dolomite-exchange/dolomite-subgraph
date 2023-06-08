/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  BigInt,
  Bytes,
  store,
  Address,
  BigDecimal,
  log,
} from '@graphprotocol/graph-ts'
import {
  DolomiteMargin as DolomiteMarginProtocol,
  LogAddMarket as AddMarketEvent,
  LogRemoveMarket as RemoveMarketEvent,
  LogSetEarningsRate as EarningsRateUpdateEvent,
  LogSetIsClosing as IsClosingUpdateEvent,
  LogSetLiquidationSpread as LiquidationSpreadUpdateEvent,
  LogSetMarginPremium as MarginPremiumUpdateEvent,
  LogSetMarginRatio as MarginRatioUpdateEvent,
  LogSetMinBorrowedValue as MinBorrowedValueUpdateEvent,
  LogSetSpreadPremium as MarketSpreadPremiumUpdateEvent,
  LogSetMaxWei as MaxWeiUpdateEvent,
  LogSetPriceOracle as PriceOracleUpdateEvent,
  LogSetInterestSetter as InterestSetterUpdateEvent,
  LogSetMaxNumberOfMarketsWithBalancesAndDebt as MaxNumberOfMarketsWithBalancesAndDebtUpdateEvent
} from '../types/MarginAdmin/DolomiteMargin'
import {
  DolomiteMargin,
  InterestIndex,
  InterestRate,
  MarketRiskInfo,
  OraclePrice,
  Token,
  TokenMarketIdReverseLookup,
  TotalPar,
} from '../types/schema'
import {
  convertTokenToDecimal,
  initializeToken
} from './amm-helpers'
import {
  ONE_ETH_BD,
  DOLOMITE_MARGIN_ADDRESS,
  ONE_BD,
  ZERO_BD, INTEREST_PRECISION, ADDRESS_ZERO,
} from './generated/constants'
import { getOrCreateDolomiteMarginForCall } from './margin-helpers'
import { ProtocolType } from './margin-types'
import { updateInterestRate } from './interest-setter'

// noinspection JSUnusedGlobalSymbols
export function handleMarketAdded(event: AddMarketEvent): void {
  log.info(
    'Adding market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.numberOfMarkets = marginProtocol.getNumMarkets()
    .toI32()
  dolomiteMargin.save()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [tokenAddress])
    token = new Token(tokenAddress)
    initializeToken(token, event.params.marketId)
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
    BigInt.fromI32(36 - token.decimals.toI32())
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

// noinspection JSUnusedGlobalSymbols
export function handleMarketRemoved(event: RemoveMarketEvent): void {
  log.info(
    'Removing market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
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

// noinspection JSUnusedGlobalSymbols
export function handleEarningsRateUpdate(event: EarningsRateUpdateEvent): void {
  log.info(
    'Handling earnings rate change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
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

// noinspection JSUnusedGlobalSymbols
export function handleSetLiquidationReward(event: LiquidationSpreadUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let liquidationPremiumBD = new BigDecimal(event.params.liquidationSpread.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.liquidationReward = liquidationPremiumBD.div(ONE_ETH_BD)
    .plus(ONE_BD)
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetMaxNumberOfMarketsWithBalancesAndDebt(
  event: MaxNumberOfMarketsWithBalancesAndDebtUpdateEvent
): void {
  log.info(
    'Handling max # of markets with balances and debt change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.maxNumberOfMarketsWithBalancesAndDebt = event.params.maxNumberOfMarketsWithBalancesAndDebt
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetLiquidationRatio(event: MarginRatioUpdateEvent): void {
  log.info(
    'Handling liquidation ratio change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let liquidationRatioBD = new BigDecimal(event.params.marginRatio.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.liquidationRatio = liquidationRatioBD.div(ONE_ETH_BD)
    .plus(ONE_BD)
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetMinBorrowedValue(event: MinBorrowedValueUpdateEvent): void {
  log.info(
    'Handling min borrowed value change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let minBorrowedValueBD = new BigDecimal(event.params.minBorrowedValue.value)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(ONE_ETH_BD)
    .div(ONE_ETH_BD)
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetMarginPremium(event: MarginPremiumUpdateEvent): void {
  log.info(
    'Handling margin premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  let marginPremium = new BigDecimal(event.params.marginPremium.value)
  marketInfo.marginPremium = marginPremium.div(ONE_ETH_BD)
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetLiquidationSpreadPremium(event: MarketSpreadPremiumUpdateEvent): void {
  log.info(
    'Handling liquidation spread premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  let spreadPremium = new BigDecimal(event.params.spreadPremium.value)
  marketInfo.liquidationRewardPremium = spreadPremium.div(ONE_ETH_BD)
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetIsMarketClosing(event: IsClosingUpdateEvent): void {
  log.info(
    'Handling set_market_closing for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  marketInfo.isBorrowingDisabled = event.params.isClosing
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetMaxWei(event: MaxWeiUpdateEvent): void {
  log.info(
    'Handling max wei change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  marketInfo.supplyMaxWei = convertTokenToDecimal(event.params.maxWei.value, token.decimals)
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetPriceOracle(event: PriceOracleUpdateEvent): void {
  log.info(
    'Handling oracle change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let marketInfo = MarketRiskInfo.load(token.id) as MarketRiskInfo
  marketInfo.oracle = event.params.priceOracle
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetInterestSetter(event: InterestSetterUpdateEvent): void {
  log.info(
    'Handling interest setter change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let interestRate = InterestRate.load(token.id) as InterestRate
  interestRate.interestSetter = event.params.interestSetter
  interestRate.save()

  let totalPar = TotalPar.load(token.id) as TotalPar
  let index = InterestIndex.load(token.id) as InterestIndex
  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  updateInterestRate(token, totalPar, index, dolomiteMargin)
}
