import { Address, BigDecimal, BigInt, Bytes, ethereum, store } from '@graphprotocol/graph-ts'
import { AmmBurn, AmmFactory, AmmMint, AmmPair, AmmTrade, Bundle, Token, Transaction } from '../types/schema'
import {
  AmmPair as AmmPairContract,
  Burn as AmmBurnEvent,
  Mint as AmmMintEvent,
  Swap as AmmTradeEvent,
  Sync as SyncEvent,
  Transfer as TransferEvent,
} from '../types/templates/AmmPair/AmmPair'
import {
  convertTokenToDecimal,
  createLiquidityPosition,
  createLiquiditySnapshot,
  createUserIfNecessary,
} from './helpers/amm-helpers'
import { findEthPerToken, getEthPriceInUSD, getTokenOraclePriceUSD, getTrackedLiquidityUSD } from './pricing'
import {
  updateDolomiteDayData,
  updateDolomiteHourData,
  updatePairDayData,
  updatePairHourData,
  updateTokenDayDataForAmmEvent,
  updateTokenHourDataForAmmEvent,
} from './day-updates'
import { _18_BI, ADDRESS_ZERO, FACTORY_ADDRESS, ONE_BI, ZERO_BD } from './generated/constants'
import { ProtocolType } from './margin-types'

function isCompleteMint(mintId: string): boolean {
  return (AmmMint.load(mintId) as AmmMint).sender !== null // sufficient checks
}

export function getOrCreateTransaction(event: ethereum.Event): Transaction {
  let transactionID = event.transaction.hash.toHexString()
  let transaction = Transaction.loadInBlock(transactionID)
  if (transaction === null) {
    transaction = new Transaction(transactionID)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.intermitentAmmMints = []
    transaction.intermitentAmmBurns = []
    transaction.intermitentAmmTrades = []
    transaction.save()
  }

  return transaction as Transaction
}

function getAmmEventID(event: ethereum.Event, allEvents: Array<string>): string {
  return `${event.transaction.hash.toHexString()}-${allEvents.length}`
}

// noinspection JSUnusedGlobalSymbols
export function handleERC20Transfer(event: TransferEvent): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let ammFactory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory

  // user stats
  let from = event.params.from
  createUserIfNecessary(from)
  let to = event.params.to
  createUserIfNecessary(to)

  // get pair and load contract
  let pair = AmmPair.load(event.address.toHexString()) as AmmPair
  let pairContract = AmmPairContract.bind(event.address)

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, _18_BI)

  // get or create transaction
  let transaction = getOrCreateTransaction(event)

  // mints
  let mints = transaction.intermitentAmmMints
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()

    // create new mint if no mints so far or if last one is done already
    if (mints.length == 0 || isCompleteMint(mints[mints.length - 1])) {
      // update factory
      ammFactory.ammMintCount = ammFactory.ammMintCount.plus(ONE_BI)

      let mint = new AmmMint(getAmmEventID(event, mints))
      mint.transaction = transaction.id
      mint.pair = pair.id
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.transaction = transaction.id
      mint.serialId = ammFactory.ammMintCount
      mint.save()

      // update mints in transaction
      transaction.intermitentAmmMints = mints.concat([mint.id])

      // save entities
      transaction.save()
      ammFactory.save()
    }
  }

  // case where direct send first on ETH withdrawals
  if (event.params.to.toHexString() == pair.id) {
    ammFactory.ammBurnCount = ammFactory.ammBurnCount.plus(ONE_BI)
    ammFactory.save()

    let burns = transaction.intermitentAmmBurns
    let burn = new AmmBurn(getAmmEventID(event, burns))
    burn.transaction = transaction.id
    burn.pair = pair.id
    burn.liquidity = value
    burn.timestamp = transaction.timestamp
    burn.to = event.params.to
    burn.sender = event.params.from
    burn.needsComplete = true
    burn.transaction = transaction.id
    burn.serialId = ammFactory.ammBurnCount
    burn.save()

    transaction.intermitentAmmBurns = burns.concat([burn.id])
    transaction.save()
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.intermitentAmmBurns
    let burn: AmmBurn
    if (burns.length > 0) {
      let currentBurn = AmmBurn.load(burns[burns.length - 1]) as AmmBurn
      if (currentBurn.needsComplete) {
        burn = currentBurn
      } else {
        ammFactory.ammBurnCount = ammFactory.ammBurnCount.plus(ONE_BI)

        burn = new AmmBurn(getAmmEventID(event, burns))
        burn.transaction = transaction.id
        burn.needsComplete = false
        burn.pair = pair.id
        burn.liquidity = value
        burn.transaction = transaction.id
        burn.timestamp = transaction.timestamp
        burn.serialId = ammFactory.ammBurnCount

        ammFactory.ammBurnCount = ammFactory.ammBurnCount.plus(ONE_BI)
        ammFactory.save()
      }
    } else {
      burn = new AmmBurn(getAmmEventID(event, burns))
      burn.transaction = transaction.id
      burn.needsComplete = false
      burn.pair = pair.id
      burn.liquidity = value
      burn.transaction = transaction.id
      burn.timestamp = transaction.timestamp
      burn.serialId = ammFactory.ammBurnCount

      ammFactory.ammBurnCount = ammFactory.ammBurnCount.plus(ONE_BI)
      ammFactory.save()
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length != 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = AmmMint.load(mints[mints.length - 1]) as AmmMint
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])

      // update the transaction
      transaction.intermitentAmmMints = mints.slice(0, mints.length - 1)
      transaction.save()
    }
    burn.save()

    if (burn.needsComplete) {
      // if accessing last one, replace it
      transaction.intermitentAmmBurns = burns.slice(0, burns.length - 1)
        .concat([burn.id])
    } else {
      // else add new one
      transaction.intermitentAmmBurns = burns.concat([burn.id])
    }
    transaction.save()
  }

  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), _18_BI)
    fromUserLiquidityPosition.save()
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), _18_BI)
    toUserLiquidityPosition.save()
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }
}

// noinspection JSUnusedGlobalSymbols
export function handleSync(event: SyncEvent): void {
  let ammPair = AmmPair.load(event.address.toHex()) as AmmPair
  let token0 = Token.load(ammPair.token0) as Token
  let token1 = Token.load(ammPair.token1) as Token
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory

  // reset factory liquidity by subtracting only tracked liquidity
  ammFactory.ammLiquidityUSD = ammFactory.ammLiquidityUSD.minus(ammPair.reserveUSD)

  // reset token total liquidity amounts
  token0.ammTradeLiquidity = token0.ammTradeLiquidity.minus(ammPair.reserve0)
  token1.ammTradeLiquidity = token1.ammTradeLiquidity.minus(ammPair.reserve1)

  ammPair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  ammPair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

  if (ammPair.reserve1.notEqual(ZERO_BD)) {
    ammPair.token0Price = ammPair.reserve0.div(ammPair.reserve1)
  } else {
    ammPair.token0Price = ZERO_BD
  }

  if (ammPair.reserve0.notEqual(ZERO_BD)) {
    ammPair.token1Price = ammPair.reserve1.div(ammPair.reserve0)
  } else {
    ammPair.token1Price = ZERO_BD
  }

  ammPair.save()

  // update ETH price, since reserves could have changed
  let bundle = Bundle.load('1') as Bundle
  bundle.ethPrice = getEthPriceInUSD()
  bundle.save()

  token0.derivedETH = findEthPerToken(token0)
  token0.save()
  token1.derivedETH = findEthPerToken(token1)
  token1.save()

  // get tracked liquidity - if neither token is in whitelist, this will be 0
  let trackedLiquidityETH: BigDecimal
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(ammPair.reserve0, token0, ammPair.reserve1, token1)
      .div(bundle.ethPrice)
  } else {
    trackedLiquidityETH = ZERO_BD
  }

  // use derived amounts within pair
  ammPair.trackedReserveETH = trackedLiquidityETH
  ammPair.reserveETH = (ammPair.reserve0.times(token0.derivedETH as BigDecimal)).plus(ammPair.reserve1.times(token1.derivedETH as BigDecimal))
  ammPair.reserveUSD = ammPair.reserveETH.times(bundle.ethPrice)

  // use tracked amounts globally
  ammFactory.ammLiquidityUSD = ammFactory.ammLiquidityUSD.plus(ammPair.reserveUSD)

  // now correctly set liquidity amounts for each token
  token0.ammTradeLiquidity = token0.ammTradeLiquidity.plus(ammPair.reserve0)
  token1.ammTradeLiquidity = token1.ammTradeLiquidity.plus(ammPair.reserve1)

  // save entities
  ammPair.save()
  ammFactory.save()
  token0.save()
  token1.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleMint(event: AmmMintEvent): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString()) as Transaction
  let mints = transaction.intermitentAmmMints
  let mint = AmmMint.load(mints[mints.length - 1]) as AmmMint

  let pair = AmmPair.load(event.address.toHex()) as AmmPair
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory

  let token0 = Token.load(pair.token0) as Token
  let token1 = Token.load(pair.token1) as Token

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0Wei, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1Wei, token1.decimals)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let amountTotalUSD = getTokenOraclePriceUSD(token0, event, ProtocolType.Amm)
    .times(token0Amount)
    .plus(getTokenOraclePriceUSD(token1, event, ProtocolType.Amm)
      .times(token1Amount))

  // update txn counts
  pair.transactionCount = pair.transactionCount.plus(ONE_BI)
  ammFactory.transactionCount = ammFactory.transactionCount.plus(ONE_BI)

  // save entities
  token0.save()
  token1.save()
  pair.save()
  ammFactory.save()

  mint.sender = event.params.sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.amountUSD = amountTotalUSD as BigDecimal
  mint.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, Address.fromString(mint.to.toHexString()))
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateDolomiteDayData(event)
  updateDolomiteHourData(event)
  updateTokenHourDataForAmmEvent(token0, event)
  updateTokenHourDataForAmmEvent(token1, event)
  updateTokenDayDataForAmmEvent(token0, event)
  updateTokenDayDataForAmmEvent(token1, event)
}

// noinspection JSUnusedGlobalSymbols
export function handleBurn(event: AmmBurnEvent): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.intermitentAmmBurns
  let burn = AmmBurn.load(burns[burns.length - 1]) as AmmBurn

  let ammPair = AmmPair.load(event.address.toHex()) as AmmPair
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory

  //update token info
  let token0 = Token.load(ammPair.token0) as Token
  let token1 = Token.load(ammPair.token1) as Token
  let token0Amount = convertTokenToDecimal(event.params.amount0Wei, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1Wei, token1.decimals)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let amountTotalUSD = getTokenOraclePriceUSD(token0, event, ProtocolType.Amm)
    .times(token0Amount)
    .plus(getTokenOraclePriceUSD(token1, event, ProtocolType.Amm)
      .times(token1Amount))

  // update txn counts
  ammFactory.transactionCount = ammFactory.transactionCount.plus(ONE_BI)
  ammPair.transactionCount = ammPair.transactionCount.plus(ONE_BI)

  // update global counter and save
  token0.save()
  token1.save()
  ammPair.save()
  ammFactory.save()

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal
  burn.amount1 = token1Amount as BigDecimal
  // burn.to = event.params.to
  burn.logIndex = event.logIndex
  burn.amountUSD = amountTotalUSD as BigDecimal
  burn.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(
    event.address,
    Address.fromString((burn.sender as Bytes).toHexString()),
  )
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateDolomiteDayData(event)
  updateDolomiteHourData(event)
  updateTokenDayDataForAmmEvent(token0, event)
  updateTokenDayDataForAmmEvent(token1, event)
}

// noinspection JSUnusedGlobalSymbols
export function handleSwap(event: AmmTradeEvent): void {
  let pair = AmmPair.load(event.address.toHexString()) as AmmPair
  let token0 = Token.load(pair.token0) as Token
  let token1 = Token.load(pair.token1) as Token
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In)
  let amount1Total = amount1Out.plus(amount1In)

  // ETH/USD prices
  let bundle = Bundle.load('1') as Bundle

  // get total amounts of derived USD and ETH for tracking
  let derivedAmountETH = (token1.derivedETH as BigDecimal)
    .times(amount1Total)
    .plus((token0.derivedETH as BigDecimal).times(amount0Total))
    .div(BigDecimal.fromString('2'))

  let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

  let token0PriceUSD = getTokenOraclePriceUSD(token0, event, ProtocolType.Amm)
  let token1PriceUSD = getTokenOraclePriceUSD(token1, event, ProtocolType.Amm)

  // only accounts for volume through white listed tokens
  let fairTokenVolume = amount0Total.times(token0PriceUSD)
    .plus(amount1Total.times(token1PriceUSD))
    .div(BigDecimal.fromString('2'))

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(fairTokenVolume)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(fairTokenVolume)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  let volumeUSD = amount0In.times(token0PriceUSD).plus(amount1In.times(token1PriceUSD))
  pair.volumeUSD = pair.volumeUSD.plus(volumeUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.transactionCount = pair.transactionCount.plus(ONE_BI)
  pair.save()

  // update global values, only used tracked amounts for volume
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS) as AmmFactory
  ammFactory.totalAmmVolumeUSD = ammFactory.totalAmmVolumeUSD.plus(volumeUSD)
  ammFactory.untrackedAmmVolumeUSD = ammFactory.untrackedAmmVolumeUSD.plus(derivedAmountUSD)
  ammFactory.transactionCount = ammFactory.transactionCount.plus(ONE_BI)
  ammFactory.ammTradeCount = ammFactory.ammTradeCount.plus(ONE_BI)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  ammFactory.save()

  let transaction = getOrCreateTransaction(event)
  let ammTrade = new AmmTrade(getAmmEventID(event, transaction.intermitentAmmTrades))

  ammTrade.transaction = transaction.id
  ammTrade.pair = pair.id
  ammTrade.timestamp = transaction.timestamp
  ammTrade.transaction = transaction.id
  ammTrade.sender = event.params.sender
  ammTrade.amount0In = amount0In
  ammTrade.amount1In = amount1In
  ammTrade.amount0Out = amount0Out
  ammTrade.amount1Out = amount1Out
  ammTrade.to = event.params.to
  ammTrade.from = event.transaction.from
  ammTrade.logIndex = event.logIndex
  ammTrade.serialId = ammFactory.ammTradeCount
  // use the tracked amount if we have it
  ammTrade.amountUSD = volumeUSD
  ammTrade.save()

  // update the transaction
  transaction.intermitentAmmTrades = transaction.intermitentAmmTrades.concat([ammTrade.id])
  transaction.save()

  // update day entities
  let ammPairDayData = updatePairDayData(event)
  let ammPairHourData = updatePairHourData(event)
  let dolomiteDayData = updateDolomiteDayData(event)
  let dolomiteHourData = updateDolomiteHourData(event)
  let token0HourData = updateTokenHourDataForAmmEvent(token0, event)
  let token1HourData = updateTokenHourDataForAmmEvent(token1, event)
  let token0DayData = updateTokenDayDataForAmmEvent(token0, event)
  let token1DayData = updateTokenDayDataForAmmEvent(token1, event)

  // swap specific updating
  dolomiteDayData.dailyAmmTradeVolumeUSD = dolomiteDayData.dailyAmmTradeVolumeUSD.plus(volumeUSD)
  dolomiteDayData.dailyAmmTradeVolumeUntracked = dolomiteDayData.dailyAmmTradeVolumeUntracked.plus(derivedAmountUSD)
  dolomiteDayData.dailyAmmTradeCount = dolomiteDayData.dailyAmmTradeCount.plus(ONE_BI)
  dolomiteDayData.save()

  // swap specific updating
  dolomiteHourData.hourlyAmmTradeVolumeUSD = dolomiteHourData.hourlyAmmTradeVolumeUSD.plus(volumeUSD)
  dolomiteHourData.hourlyAmmTradeVolumeUntracked = dolomiteHourData.hourlyAmmTradeVolumeUntracked.plus(derivedAmountUSD)
  dolomiteHourData.hourlyAmmTradeCount = dolomiteHourData.hourlyAmmTradeCount.plus(ONE_BI)
  dolomiteHourData.save()

  // swap specific updating for pair
  ammPairDayData.dailyVolumeToken0 = ammPairDayData.dailyVolumeToken0.plus(amount0Total)
  ammPairDayData.dailyVolumeToken1 = ammPairDayData.dailyVolumeToken1.plus(amount1Total)
  ammPairDayData.dailyVolumeUSD = ammPairDayData.dailyVolumeUSD.plus(volumeUSD)
  ammPairDayData.save()

  // update hourly pair data
  ammPairHourData.hourlyVolumeToken0 = ammPairHourData.hourlyVolumeToken0.plus(amount0Total)
  ammPairHourData.hourlyVolumeToken1 = ammPairHourData.hourlyVolumeToken1.plus(amount1Total)
  ammPairHourData.hourlyVolumeUSD = ammPairHourData.hourlyVolumeUSD.plus(volumeUSD)
  ammPairHourData.save()

  // swap specific updating for token0
  token0DayData.dailyAmmTradeVolumeToken = token0DayData.dailyAmmTradeVolumeToken.plus(amount0Total)
  token0DayData.dailyAmmTradeVolumeUSD = token0DayData.dailyAmmTradeVolumeUSD.plus(amount0Total.times(token0PriceUSD))
  token0DayData.dailyAmmTradeCount = token0DayData.dailyAmmTradeCount.plus(ONE_BI)
  token0DayData.save()

  token0HourData.hourlyAmmTradeVolumeToken = token0HourData.hourlyAmmTradeVolumeToken.plus(amount0Total)
  token0HourData.hourlyAmmTradeVolumeUSD = token0HourData.hourlyAmmTradeVolumeUSD.plus(amount0Total.times(token0PriceUSD))
  token0HourData.hourlyAmmTradeCount = token0HourData.hourlyAmmTradeCount.plus(ONE_BI)
  token0HourData.save()

  // swap specific updating
  token1DayData.dailyAmmTradeVolumeToken = token1DayData.dailyAmmTradeVolumeToken.plus(amount1Total)
  token1DayData.dailyAmmTradeVolumeUSD = token1DayData.dailyAmmTradeVolumeUSD.plus(amount1Total.times(token1PriceUSD))
  token1DayData.dailyAmmTradeCount = token1DayData.dailyAmmTradeCount.plus(ONE_BI)
  token1DayData.save()

  token1HourData.hourlyAmmTradeVolumeToken = token1HourData.hourlyAmmTradeVolumeToken.plus(amount1Total)
  token1HourData.hourlyAmmTradeVolumeUSD = token1HourData.hourlyAmmTradeVolumeUSD.plus(amount1Total.times(token1PriceUSD))
  token1HourData.hourlyAmmTradeCount = token1HourData.hourlyAmmTradeCount.plus(ONE_BI)
  token1HourData.save()
}
