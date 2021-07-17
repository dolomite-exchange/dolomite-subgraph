import { BigDecimal, BigInt, ethereum, store, Address } from '@graphprotocol/graph-ts'
import { AmmBurn, AmmFactory, AmmMint, AmmPair, AmmSwap, Bundle, Token, Transaction } from '../types/schema'
import {
  Burn as BurnEvent,
  Mint as MintEvent,
  AmmPair as AmmPairContract,
  Swap as SwapEvent,
  Sync as SyncEvent,
  Transfer as TransferEvent
} from '../types/templates/AmmPair/AmmPair'
import {
  updateDolomiteDayData,
  updatePairDayData,
  updatePairHourData,
  updateTokenDayDataForAmmEvent,
  updateTokenHourDataForAmmEvent
} from './dayUpdates'
import { findEthPerToken, getEthPriceInUSD, getTrackedLiquidityUSD, getTrackedVolumeUSD } from './pricing'
import {
  ADDRESS_ZERO,
  BI_18,
  convertTokenToDecimal,
  createLiquidityPosition,
  createLiquiditySnapshot,
  createUser,
  FACTORY_ADDRESS,
  ONE_BI,
  ZERO_BD
} from './helpers'

function isCompleteMint(mintId: string): boolean {
  return AmmMint.load(mintId).sender !== null // sufficient checks
}

export function getOrCreateTransaction(event: ethereum.Event): Transaction {
  let transactionID = event.transaction.hash.toHexString()
  let transaction = Transaction.load(transactionID)
  if (transaction === null) {
    transaction = new Transaction(transactionID)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.intermitentMints = []
    transaction.intermitentBurns = []
    transaction.intermitentSwaps = []
  }

  return transaction as Transaction
}

function getAmmEventID(event: ethereum.Event, allEvents: Array<string>): string {
  return event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(allEvents.length).toString())
}

export function handleERC20Transfer(event: TransferEvent): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let ammFactory = AmmFactory.load(FACTORY_ADDRESS)

  // user stats
  let from = event.params.from
  createUser(from)
  let to = event.params.to
  createUser(to)

  // get pair and load contract
  let pair = AmmPair.load(event.address.toHexString())
  let pairContract = AmmPairContract.bind(event.address)

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18)

  // get or create transaction
  let transaction = getOrCreateTransaction(event)

  // mints
  let mints = transaction.intermitentMints
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()

    // create new mint if no mints so far or if last one is done already
    if (mints.length == 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new AmmMint(getAmmEventID(event, mints))
      mint.transaction = transaction.id
      mint.pair = pair.id
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.transaction = transaction.id
      mint.save()

      // update mints in transaction
      transaction.intermitentMints = mints.concat([mint.id])

      // save entities
      transaction.save()
      ammFactory.save()
    }
  }

  // case where direct send first on ETH withdrawals
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.intermitentBurns
    let burn = new AmmBurn(getAmmEventID(event, burns))
    burn.transaction = transaction.id
    burn.pair = pair.id
    burn.liquidity = value
    burn.timestamp = transaction.timestamp
    burn.to = event.params.to
    burn.sender = event.params.from
    burn.needsComplete = true
    burn.transaction = transaction.id
    burn.save()

    transaction.intermitentBurns = burns.concat([burn.id])
    transaction.save()
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.intermitentBurns
    let burn: AmmBurn
    if (burns.length > 0) {
      let currentBurn = AmmBurn.load(burns[burns.length - 1])
      if (currentBurn.needsComplete) {
        burn = currentBurn as AmmBurn
      } else {
        burn = new AmmBurn(getAmmEventID(event, burns))
        burn.transaction = transaction.id
        burn.needsComplete = false
        burn.pair = pair.id
        burn.liquidity = value
        burn.transaction = transaction.id
        burn.timestamp = transaction.timestamp
      }
    } else {
      burn = new AmmBurn(getAmmEventID(event, burns))
      burn.transaction = transaction.id
      burn.needsComplete = false
      burn.pair = pair.id
      burn.liquidity = value
      burn.transaction = transaction.id
      burn.timestamp = transaction.timestamp
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length != 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = AmmMint.load(mints[mints.length - 1])
      burn.feeTo = mint.to
      burn.feeLiquidity = mint.liquidity
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])

      // update the transaction
      transaction.intermitentMints = mints.slice(0, mints.length - 1)
      transaction.save()
    }
    burn.save()

    if (burn.needsComplete) {
      // if accessing last one, replace it
      transaction.intermitentBurns = burns.slice(0, burns.length - 1).concat([burn.id])
    } else {
      // else add new one
      transaction.intermitentBurns = burns.concat([burn.id])
    }
    transaction.save()
  }

  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18)
    fromUserLiquidityPosition.save()
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18)
    toUserLiquidityPosition.save()
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }

  transaction.save()
}

export function handleSync(event: SyncEvent): void {
  let ammPair = AmmPair.load(event.address.toHex())
  let token0 = Token.load(ammPair.token0) as Token
  let token1 = Token.load(ammPair.token1) as Token
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS)

  // reset factory liquidity by subtracting only tracked liquidity
  ammFactory.ammLiquidityUSD = ammFactory.ammLiquidityUSD.minus(ammPair.reserveUSD)

  // reset token total liquidity amounts
  token0.ammSwapLiquidity = token0.ammSwapLiquidity.minus(ammPair.reserve0)
  token1.ammSwapLiquidity = token1.ammSwapLiquidity.minus(ammPair.reserve1)

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
  let bundle = Bundle.load('1')
  bundle.ethPrice = getEthPriceInUSD()
  bundle.save()

  token0.derivedETH = findEthPerToken(token0)
  token0.save()
  token1.derivedETH = findEthPerToken(token1)
  token1.save()

  // get tracked liquidity - if neither token is in whitelist, this will be 0
  let trackedLiquidityETH: BigDecimal
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(ammPair.reserve0, token0, ammPair.reserve1, token1).div(bundle.ethPrice)
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
  token0.ammSwapLiquidity = token0.ammSwapLiquidity.plus(ammPair.reserve0)
  token1.ammSwapLiquidity = token1.ammSwapLiquidity.plus(ammPair.reserve1)

  // save entities
  ammPair.save()
  ammFactory.save()
  token0.save()
  token1.save()
}

export function handleMint(event: MintEvent): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  let mints = transaction.intermitentMints
  let mint = AmmMint.load(mints[mints.length - 1])

  let pair = AmmPair.load(event.address.toHex())
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS)

  let token0 = Token.load(pair.token0) as Token
  let token1 = Token.load(pair.token1) as Token

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let bundle = Bundle.load('1')
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundle.ethPrice)

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
  updateTokenHourDataForAmmEvent(token0, event)
  updateTokenHourDataForAmmEvent(token1, event)
  updateTokenDayDataForAmmEvent(token0, event)
  updateTokenDayDataForAmmEvent(token1, event)
}

export function handleBurn(event: BurnEvent): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.intermitentBurns
  let burn = AmmBurn.load(burns[burns.length - 1])

  let ammPair = AmmPair.load(event.address.toHex())
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS)

  //update token info
  let token0 = Token.load(ammPair.token0) as Token
  let token1 = Token.load(ammPair.token1) as Token
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let bundle = Bundle.load('1')
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundle.ethPrice)

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
  let liquidityPosition = createLiquidityPosition(event.address, Address.fromString(burn.sender.toHexString()))
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateDolomiteDayData(event)
  updateTokenDayDataForAmmEvent(token0, event)
  updateTokenDayDataForAmmEvent(token1, event)
}

export function handleSwap(event: SwapEvent): void {
  let pair = AmmPair.load(event.address.toHexString())
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
  let bundle = Bundle.load('1')

  // get total amounts of derived USD and ETH for tracking
  let derivedAmountETH = token1.derivedETH
    .times(amount1Total)
    .plus(token0.derivedETH.times(amount0Total))
    .div(BigDecimal.fromString('2'))

  let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0, amount1Total, token1, pair as AmmPair)

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.transactionCount = token0.transactionCount.plus(ONE_BI)
  token1.transactionCount = token1.transactionCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.transactionCount = pair.transactionCount.plus(ONE_BI)
  pair.save()

  // update global values, only used tracked amounts for volume
  let ammFactory = AmmFactory.load(FACTORY_ADDRESS)
  ammFactory.totalAmmVolumeUSD = ammFactory.totalAmmVolumeUSD.plus(trackedAmountUSD)
  ammFactory.untrackedAmmVolumeUSD = ammFactory.untrackedAmmVolumeUSD.plus(derivedAmountUSD)
  ammFactory.transactionCount = ammFactory.transactionCount.plus(ONE_BI)
  ammFactory.swapCount = ammFactory.swapCount.plus(ONE_BI)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  ammFactory.save()

  let transaction = getOrCreateTransaction(event)
  let swap = new AmmSwap(getAmmEventID(event, transaction.intermitentSwaps))

  // update swap event
  swap.transaction = transaction.id
  swap.pair = pair.id
  swap.timestamp = transaction.timestamp
  swap.transaction = transaction.id
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to
  swap.from = event.transaction.from
  swap.logIndex = event.logIndex
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD == ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  swap.save()

  // update the transaction
  transaction.intermitentSwaps = transaction.intermitentSwaps.concat([swap.id])
  transaction.save()

  // update day entities
  let ammPairDayData = updatePairDayData(event)
  let ammPairHourData = updatePairHourData(event)
  let dolomiteDayData = updateDolomiteDayData(event)
  let token0DayData = updateTokenDayDataForAmmEvent(token0, event)
  let token1DayData = updateTokenDayDataForAmmEvent(token1, event)

  // swap specific updating
  dolomiteDayData.dailyAmmSwapVolumeUSD = dolomiteDayData.dailyAmmSwapVolumeUSD.plus(trackedAmountUSD)
  dolomiteDayData.dailyAmmSwapVolumeUntracked = dolomiteDayData.dailyAmmSwapVolumeUntracked.plus(derivedAmountUSD)
  dolomiteDayData.save()

  // swap specific updating for pair
  ammPairDayData.dailyVolumeToken0 = ammPairDayData.dailyVolumeToken0.plus(amount0Total)
  ammPairDayData.dailyVolumeToken1 = ammPairDayData.dailyVolumeToken1.plus(amount1Total)
  ammPairDayData.dailyVolumeUSD = ammPairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  ammPairDayData.save()

  // update hourly pair data
  ammPairHourData.hourlyVolumeToken0 = ammPairHourData.hourlyVolumeToken0.plus(amount0Total)
  ammPairHourData.hourlyVolumeToken1 = ammPairHourData.hourlyVolumeToken1.plus(amount1Total)
  ammPairHourData.hourlyVolumeUSD = ammPairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
  ammPairHourData.save()

  // swap specific updating for token0
  token0DayData.dailyAmmSwapVolumeToken = token0DayData.dailyAmmSwapVolumeToken.plus(amount0Total)
  token0DayData.dailyAmmSwapVolumeUSD = token0DayData.dailyAmmSwapVolumeUSD.plus(amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice))
  token0DayData.dailyAmmSwapCount = token0DayData.dailyAmmSwapCount.plus(ONE_BI)
  token0DayData.save()

  // swap specific updating
  token1DayData.dailyAmmSwapVolumeToken = token1DayData.dailyAmmSwapVolumeToken.plus(amount1Total)
  token1DayData.dailyAmmSwapVolumeUSD = token1DayData.dailyAmmSwapVolumeUSD.plus(amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice))
  token1DayData.dailyAmmSwapCount = token1DayData.dailyAmmSwapCount.plus(ONE_BI)
  token1DayData.save()
}
