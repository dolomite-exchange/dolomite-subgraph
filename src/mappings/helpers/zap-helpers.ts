import { Address, BigInt, Bytes, crypto, ethereum } from '@graphprotocol/graph-ts'
import { ZapExecuted as ZapExecutedEvent, ZapExecutedTradersPathStruct } from '../../types/Zap/GenericTraderProxy'
import { TokenMarketIdReverseLookup, Trade } from '../../types/schema'

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
