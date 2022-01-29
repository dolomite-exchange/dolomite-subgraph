import { BigInt } from '@graphprotocol/graph-ts'
import {
  Address,
  BigDecimal,
  log
} from '@graphprotocol/graph-ts/index'
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
  LogSetSpreadPremium as MarketSpreadPremiumUpdateEvent
} from '../types/MarginAdmin/DolomiteMargin'
import {
  InterestIndex,
  InterestRate,
  MarketRiskInfo,
  OraclePrice,
  Token
} from '../types/schema'
import {
  convertTokenToDecimal,
  initializeToken
} from './amm-helpers'
import {
  BD_ONE_ETH,
  DOLOMITE_MARGIN_ADDRESS,
  ONE_BD,
  ZERO_BD,
  ZERO_BI
} from './generated/constants'
import { getOrCreateDolomiteMarginForCall } from './margin-helpers'
import { ProtocolType } from './margin-types'

// TODO handle withdraw excess changing balance?

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

  let id = event.params.marketId.toString()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [event.params.token.toHexString()])
    token = new Token(tokenAddress)
    initializeToken(token as Token, event.params.marketId)
    token.save()
  }

  let index = new InterestIndex(id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.token = token.id
  index.save()

  let interestRate = new InterestRate(id)
  interestRate.borrowInterestRate = ZERO_BD
  interestRate.supplyInterestRate = ZERO_BD
  interestRate.token = token.id
  interestRate.save()

  let oraclePrice = new OraclePrice(id)
  oraclePrice.price = convertTokenToDecimal(
    marginProtocol.getMarketPrice(event.params.marketId).value,
    BigInt.fromI32(36 - token.decimals.toI32())
  )
  oraclePrice.blockNumber = event.block.number
  oraclePrice.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleMarketRemoved(event: RemoveMarketEvent): void {
  log.info(
    'Removing market[{}] for token {} for hash and index: {}-{}',
    [event.params.marketId.toString(), event.params.token.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.numberOfMarkets = dolomiteMargin.numberOfMarkets + 1
  dolomiteMargin.save()

  let id = event.params.marketId.toString()

  let tokenAddress = event.params.token.toHexString()
  let token = Token.load(tokenAddress)
  if (token === null) {
    log.info('Adding new token to store {}', [event.params.token.toHexString()])
    token = new Token(tokenAddress)
    initializeToken(token as Token, event.params.marketId)
    token.save()
  }

  let index = new InterestIndex(id)
  index.borrowIndex = BigDecimal.fromString('1.0')
  index.supplyIndex = BigDecimal.fromString('1.0')
  index.lastUpdate = event.block.timestamp
  index.token = token.id
  index.save()

  let interestRate = new InterestRate(id)
  interestRate.borrowInterestRate = ZERO_BD
  interestRate.supplyInterestRate = ZERO_BD
  interestRate.token = token.id
  interestRate.save()

  let oraclePrice = new OraclePrice(id)
  oraclePrice.price = ZERO_BD
  oraclePrice.blockNumber = ZERO_BI
  oraclePrice.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleEarningsRateUpdate(event: EarningsRateUpdateEvent): void {
  log.info(
    'Handling earnings rate change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let earningsRateBD = new BigDecimal(event.params.earningsRate.value)
  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Admin)
  dolomiteMargin.earningsRate = earningsRateBD.div(BD_ONE_ETH) // it's a ratio where ONE_ETH is 100%
  dolomiteMargin.save()

  let numMarkets = dolomiteMargin.numberOfMarkets

  for (let i = 0; i < numMarkets; i++) {
    let interestRate = InterestRate.load(i.toString()) as InterestRate
    interestRate.supplyInterestRate = interestRate.borrowInterestRate.times(dolomiteMargin.earningsRate)
      .truncate(18)
    interestRate.save()
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
  dolomiteMargin.liquidationReward = liquidationPremiumBD.div(BD_ONE_ETH)
    .plus(ONE_BD)
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
  dolomiteMargin.liquidationRatio = liquidationRatioBD.div(BD_ONE_ETH)
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
  dolomiteMargin.minBorrowedValue = minBorrowedValueBD.div(BD_ONE_ETH)
    .div(BD_ONE_ETH)
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetMarginPremium(event: MarginPremiumUpdateEvent): void {
  log.info(
    'Handling margin premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId)
      .toHexString()
    marketInfo.liquidationRewardPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  let marginPremium = new BigDecimal(event.params.marginPremium.value)
  marketInfo.marginPremium = marginPremium.div(BD_ONE_ETH)
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetLiquidationSpreadPremium(event: MarketSpreadPremiumUpdateEvent): void {
  log.info(
    'Handling liquidation spread premium change for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId)
      .toHexString()
    marketInfo.marginPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  let spreadPremium = new BigDecimal(event.params.spreadPremium.value)
  marketInfo.liquidationRewardPremium = spreadPremium.div(BD_ONE_ETH)
  marketInfo.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetIsMarketClosing(event: IsClosingUpdateEvent): void {
  log.info(
    'Handling set_market_closing for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let marketInfo = MarketRiskInfo.load(event.params.marketId.toString())
  if (marketInfo === null) {
    marketInfo = new MarketRiskInfo(event.params.marketId.toString())
    marketInfo.token = marginProtocol.getMarketTokenAddress(event.params.marketId)
      .toHexString()
    marketInfo.marginPremium = ZERO_BD
    marketInfo.liquidationRewardPremium = ZERO_BD
    marketInfo.isBorrowingDisabled = false
  }
  marketInfo.isBorrowingDisabled = event.params.isClosing
  marketInfo.save()
}
