import { Address, BigDecimal, BigInt, Bytes, crypto, ethereum, log, TypedMap } from '@graphprotocol/graph-ts'
import { ZapExecuted as ZapExecutedEvent, ZapExecutedTradersPathStruct } from '../types/Zap/GenericTraderProxy'
import {
  DolomiteMargin,
  MarginAccount,
  Token,
  TokenMarketIdReverseLookup,
  Trade,
  Transaction,
  Transfer,
  User,
  Zap,
  ZapTraderParam,
} from '../types/schema'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import {
  DOLOMITE_MARGIN_ADDRESS,
  MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS,
  MAGIC_GLP_WRAPPER_TRADER_ADDRESS,
  ONE_BI,
  ZERO_BD,
} from './generated/constants'
import { absBD } from './helpers/helpers'

function getZapAccountNumber(event: ZapExecutedEvent): BigInt {
  let packedInner = new ethereum.Tuple()
  packedInner.push(ethereum.Value.fromUnsignedBigInt(event.params.accountNumber))
  packedInner.push(ethereum.Value.fromUnsignedBigInt(event.block.timestamp))
  let packed = event.params.accountOwner.concat(ethereum.encode(ethereum.Value.fromTuple(packedInner)) as Bytes)

  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(crypto.keccak256(packed).reverse()))
}

function getTokenPathForZap(event: ZapExecutedEvent): Array<string> {
  let tokenPath: Array<string> = []
  for (let i = 0; i < event.params.marketIdsPath.length; i++) {
    let marketId = event.params.marketIdsPath[i]
    tokenPath[i] = (TokenMarketIdReverseLookup.load(marketId.toString()) as TokenMarketIdReverseLookup).token
  }
  return tokenPath
}

const LIQUIDITY_TOKEN_ADDRESS_MAP: TypedMap<string, string> = new TypedMap<string, string>()
LIQUIDITY_TOKEN_ADDRESS_MAP.set(MAGIC_GLP_UNWRAPPER_TRADER_ADDRESS, 'true')
LIQUIDITY_TOKEN_ADDRESS_MAP.set(MAGIC_GLP_WRAPPER_TRADER_ADDRESS, 'true')

function getTradesByTrader(trades: Array<Trade>, trader: Address): Array<Trade> {
  let filteredTrades: Array<Trade> = []
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].traderAddress.equals(trader)) {
      filteredTrades.push(trades[i])
    }
  }
  return filteredTrades
}

function removeTradeMetricsForTrader(
  trader: ZapExecutedTradersPathStruct,
  dolomiteMargin: DolomiteMargin,
  tradesForTransaction: Trade[],
): void {
  let trades = getTradesByTrader(tradesForTransaction, trader.trader)
  for (let i = 0; i < trades.length; i++) {
    log.info('Removing trade volume for trader: {}', [trader.trader.toHexString()])
    let trade = trades[i] as Trade

    dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.minus(ONE_BI)
    dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.minus(trade.amountUSD)
    // dolomiteMargin is saved later

    let takerToken = Token.load(trade.takerToken) as Token
    takerToken.tradeVolume = takerToken.tradeVolume.minus(trade.takerTokenDeltaWei)
    takerToken.tradeVolumeUSD = takerToken.tradeVolumeUSD.minus(trade.amountUSD)
    takerToken.save()

    let makerToken = Token.load(trade.makerToken) as Token
    makerToken.tradeVolume = makerToken.tradeVolume.minus(trade.makerTokenDeltaWei)
    makerToken.tradeVolumeUSD = makerToken.tradeVolumeUSD.minus(trade.amountUSD)
    makerToken.save()

    let takerUser = User.load((MarginAccount.load(trade.takerMarginAccount) as MarginAccount).user) as User
    takerUser.totalTradeVolumeUSD = takerUser.totalTradeVolumeUSD.minus(trade.amountUSD)
    takerUser.totalTradeCount = takerUser.totalTradeCount.minus(ONE_BI)
    takerUser.save()
    if (takerUser.effectiveUser != takerUser.id) {
      let effectiveTakerUser = User.load(takerUser.effectiveUser) as User
      effectiveTakerUser.totalTradeVolumeUSD = effectiveTakerUser.totalTradeVolumeUSD.minus(trade.amountUSD)
      effectiveTakerUser.totalTradeCount = effectiveTakerUser.totalTradeCount.minus(ONE_BI)
      effectiveTakerUser.save()
    }

    let makerMarginAccount = trade.makerMarginAccount
    if (makerMarginAccount !== null) {
      let makerUser = User.load((MarginAccount.load(makerMarginAccount) as MarginAccount).user) as User
      makerUser.totalTradeVolumeUSD = makerUser.totalTradeVolumeUSD.minus(trade.amountUSD)
      makerUser.totalTradeCount = makerUser.totalTradeCount.minus(ONE_BI)
      makerUser.save()
      if (makerUser.effectiveUser != makerUser.id) {
        let effectiveMakerUser = User.load(makerUser.effectiveUser) as User
        effectiveMakerUser.totalTradeVolumeUSD = effectiveMakerUser.totalTradeVolumeUSD.minus(trade.amountUSD)
        effectiveMakerUser.totalTradeCount = effectiveMakerUser.totalTradeCount.minus(ONE_BI)
        effectiveMakerUser.save()
      }
    }
  }
}

function removeTradeMetricsIfNecessaryFromExternalLiquidityTrade(
  trader: ZapExecutedTradersPathStruct,
  dolomiteMargin: DolomiteMargin,
  tradesForTransaction: Trade[],
): void {
  if (LIQUIDITY_TOKEN_ADDRESS_MAP.get(trader.trader.toHexString()) == 'true') {
    // Remove the trade from the trade metrics (it's not a "real" trade if it's a redemption/minting)
    removeTradeMetricsForTrader(trader, dolomiteMargin, tradesForTransaction)
  }
}

export function handleZapExecuted(event: ZapExecutedEvent): void {
  log.info(
    'Handling zap for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )
  let zap = new Zap(`${event.transaction.hash.toHexString()}-${event.logIndex.toString()}`)
  zap.marginAccount = `${event.params.accountOwner.toHexString()}-${event.params.accountNumber.toString()}`
  zap.effectiveUser = getEffectiveUserForAddress(event.params.accountOwner).id
  zap.transaction = event.transaction.hash.toHexString()
  zap.tokenPath = getTokenPathForZap(event)

  let transaction = Transaction.loadInBlock(event.transaction.hash.toHexString()) as Transaction
  let transfers: Array<Transfer> = transaction.transfers.load()

  let zapAccountNumber = getZapAccountNumber(event)
  let amountInToken: BigDecimal = ZERO_BD
  let amountInUSD: BigDecimal = ZERO_BD
  let amountOutToken: BigDecimal = ZERO_BD
  let amountOutUSD: BigDecimal = ZERO_BD
  for (let i = 0; i < transfers.length; i++) {
    let toMarginAccount = MarginAccount.load(transfers[i].toMarginAccount) as MarginAccount
    let fromMarginAccount = MarginAccount.load(transfers[i].fromMarginAccount) as MarginAccount
    if (toMarginAccount.accountNumber.equals(zapAccountNumber)) {
      // Transfers into the zap account are the amount in
      amountInToken = absBD(transfers[i].amountDeltaWei)
      amountInUSD = absBD(transfers[i].amountUSDDeltaWei)
    } else if (fromMarginAccount.accountNumber.equals(zapAccountNumber)) {
      // Transfers out of the zap account are the amount out
      amountOutToken = absBD(transfers[i].amountDeltaWei)
      amountOutUSD = absBD(transfers[i].amountUSDDeltaWei)
    }

    if (amountInToken.notEqual(ZERO_BD) && amountOutToken.notEqual(ZERO_BD)) {
      break
    }
  }

  if (amountInToken.equals(ZERO_BD) || amountOutToken.equals(ZERO_BD)) {
    log.error(
      'Could not create zap! {} {} {} {}',
      [
        transfers.length.toString(),
        zapAccountNumber.toHexString(),
      ],
    )
    log.critical('Invalid state!', [])
  }

  zap.amountInToken = amountInToken
  zap.amountInUSD = amountInUSD
  zap.amountOutToken = amountOutToken
  zap.amountOutUSD = amountOutUSD
  zap.save()

  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  let tradesForTransaction = transaction.trades.load()
  for (let i = 0; i < event.params.tradersPath.length; i++) {
    let traderParamEvent = event.params.tradersPath[i]
    let traderParam = new ZapTraderParam(`${zap.id}-${i}`)
    traderParam.zap = zap.id

    if (traderParamEvent.traderType == 0) {
      traderParam.traderType = 'EXTERNAL_LIQUIDITY'
      removeTradeMetricsIfNecessaryFromExternalLiquidityTrade(
        traderParamEvent,
        dolomiteMargin,
        tradesForTransaction,
      )
    } else if (traderParamEvent.traderType == 1) {
      traderParam.traderType = 'INTERNAL_LIQUIDITY'
    } else if (traderParamEvent.traderType == 2) {
      traderParam.traderType = 'ISOLATION_MODE_UNWRAPPER'
      removeTradeMetricsForTrader(
        traderParamEvent,
        dolomiteMargin,
        tradesForTransaction,
      )
    } else if (traderParamEvent.traderType == 3) {
      traderParam.traderType = 'ISOLATION_MODE_WRAPPER'
      removeTradeMetricsForTrader(
        traderParamEvent,
        dolomiteMargin,
        tradesForTransaction,
      )
    } else {
      throw new Error(`Invalid trader type, found: ${traderParamEvent.traderType.toString()}`)
    }

    traderParam.traderAddress = traderParamEvent.trader
    traderParam.tradeData = traderParamEvent.tradeData.length == 0 ? null : traderParamEvent.tradeData
    traderParam.save()
  }

  dolomiteMargin.zapCount = dolomiteMargin.zapCount.plus(ONE_BI)
  dolomiteMargin.totalZapVolumeUSD = dolomiteMargin.totalZapVolumeUSD.plus(amountInUSD)
  dolomiteMargin.save()

  let user = User.load(event.params.accountOwner.toHexString()) as User
  user.totalZapCount = user.totalZapCount.plus(ONE_BI)
  user.totalZapVolumeUSD = user.totalZapVolumeUSD.plus(amountInUSD)
  user.save()
  if (user.effectiveUser != user.id) {
    let effectiveUser = User.load(user.effectiveUser) as User
    effectiveUser.totalZapCount = effectiveUser.totalZapCount.plus(ONE_BI)
    effectiveUser.totalZapVolumeUSD = effectiveUser.totalZapVolumeUSD.plus(amountInUSD)
    effectiveUser.save()
  }
}
