import { Address, BigInt, Bytes, crypto, ethereum, log, TypedMap } from '@graphprotocol/graph-ts'
import { MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS, MAGIC_GLP_WRAPPER_TRADER_ADDRESS, ONE_BI } from '../generated/constants'
import { ZapExecuted as ZapExecutedEvent, ZapExecutedTradersPathStruct } from '../../types/Zap/GenericTraderProxy'
import { DolomiteMargin, MarginAccount, Token, TokenMarketIdReverseLookup, Trade, User } from '../../types/schema'
import { subtractDayAndHourlyVolumeForTrade } from '../day-updates'

const LIQUIDITY_TOKEN_ADDRESS_MAP: TypedMap<string, string> = new TypedMap<string, string>()
LIQUIDITY_TOKEN_ADDRESS_MAP.set(MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS, 'true')
LIQUIDITY_TOKEN_ADDRESS_MAP.set(MAGIC_GLP_WRAPPER_TRADER_ADDRESS, 'true')

export function getZapAccountNumber(event: ZapExecutedEvent): BigInt {
  let packedInner = new ethereum.Tuple()
  packedInner.push(ethereum.Value.fromUnsignedBigInt(event.params.accountNumber))
  packedInner.push(ethereum.Value.fromUnsignedBigInt(event.block.timestamp))
  let packed = event.params.accountOwner.concat(ethereum.encode(ethereum.Value.fromTuple(packedInner)) as Bytes)

  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(crypto.keccak256(packed).reverse()))
}

export function getTokenPathForZap(event: ZapExecutedEvent): Array<string> {
  let tokenPath: Array<string> = []
  for (let i = 0; i < event.params.marketIdsPath.length; i++) {
    let marketId = event.params.marketIdsPath[i]
    tokenPath[i] = (TokenMarketIdReverseLookup.load(marketId.toString()) as TokenMarketIdReverseLookup).token
  }
  return tokenPath
}
function getTradesByTrader(trades: Array<Trade>, trader: Address): Array<Trade> {
  let filteredTrades: Array<Trade> = []
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].traderAddress.equals(trader)) {
      filteredTrades.push(trades[i])
    }
  }
  return filteredTrades
}

export function removeTradeMetricsForTrader(
  trader: ZapExecutedTradersPathStruct,
  dolomiteMargin: DolomiteMargin,
  tradesForTransaction: Trade[],
): void {
  let trades = getTradesByTrader(tradesForTransaction, trader.trader)
  for (let i = 0; i < trades.length; i++) {
    let trade = trades[i] as Trade
    if (!trade.traderAddress.equals(trader.trader)) {
      continue
    }

    log.info('Removing trade volume for trader: {}', [trader.trader.toHexString()])
    dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.minus(ONE_BI)
    dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.minus(trade.takerAmountUSD)
    // dolomiteMargin is saved later

    let takerToken = Token.load(trade.takerToken) as Token
    takerToken.tradeVolume = takerToken.tradeVolume.minus(trade.takerTokenDeltaWei)
    takerToken.tradeVolumeUSD = takerToken.tradeVolumeUSD.minus(trade.takerAmountUSD)
    takerToken.save()

    let makerToken = Token.load(trade.makerToken) as Token
    makerToken.tradeVolume = makerToken.tradeVolume.minus(trade.makerTokenDeltaWei)
    makerToken.tradeVolumeUSD = makerToken.tradeVolumeUSD.minus(trade.makerAmountUSD)
    makerToken.save()

    let takerUser = User.load((MarginAccount.load(trade.takerMarginAccount) as MarginAccount).user) as User
    takerUser.totalTradeVolumeUSD = takerUser.totalTradeVolumeUSD.minus(trade.takerAmountUSD)
    takerUser.totalTradeCount = takerUser.totalTradeCount.minus(ONE_BI)
    takerUser.save()
    if (takerUser.effectiveUser != takerUser.id) {
      let effectiveTakerUser = User.load(takerUser.effectiveUser) as User
      effectiveTakerUser.totalTradeVolumeUSD = effectiveTakerUser.totalTradeVolumeUSD.minus(trade.takerAmountUSD)
      effectiveTakerUser.totalTradeCount = effectiveTakerUser.totalTradeCount.minus(ONE_BI)
      effectiveTakerUser.save()
    }

    let makerMarginAccount = trade.makerMarginAccount
    if (makerMarginAccount !== null) {
      let makerUser = User.load((MarginAccount.load(makerMarginAccount) as MarginAccount).user) as User
      makerUser.totalTradeVolumeUSD = makerUser.totalTradeVolumeUSD.minus(trade.makerAmountUSD)
      makerUser.totalTradeCount = makerUser.totalTradeCount.minus(ONE_BI)
      makerUser.save()
      if (makerUser.effectiveUser != makerUser.id) {
        let effectiveMakerUser = User.load(makerUser.effectiveUser) as User
        effectiveMakerUser.totalTradeVolumeUSD = effectiveMakerUser.totalTradeVolumeUSD.minus(trade.makerAmountUSD)
        effectiveMakerUser.totalTradeCount = effectiveMakerUser.totalTradeCount.minus(ONE_BI)
        effectiveMakerUser.save()
      }
    }

    subtractDayAndHourlyVolumeForTrade(trade)
  }
}

export function removeTradeMetricsIfNecessaryFromExternalLiquidityTrade(
  trader: ZapExecutedTradersPathStruct,
  dolomiteMargin: DolomiteMargin,
  tradesForTransaction: Trade[],
): void {
  if (LIQUIDITY_TOKEN_ADDRESS_MAP.get(trader.trader.toHexString()) == 'true') {
    // Remove the trade from the trade metrics (it's not a "real" trade if it's a redemption/minting)
    removeTradeMetricsForTrader(trader, dolomiteMargin, tradesForTransaction)
  }
}
