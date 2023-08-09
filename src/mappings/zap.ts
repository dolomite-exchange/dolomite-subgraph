import { BigDecimal, BigInt, Bytes, crypto, ethereum } from '@graphprotocol/graph-ts'
import { ZapExecuted as ZapExecutedEvent } from '../types/Zap/GenericTraderProxy'
import {
  DolomiteMargin,
  MarginAccount,
  TokenMarketIdReverseLookup,
  Transaction,
  Transfer, User,
  Zap,
  ZapTraderParam,
} from '../types/schema'
import { getEffectiveUserForAddress } from './isolation-mode-helpers'
import { DOLOMITE_MARGIN_ADDRESS, ONE_BI, ZERO_BD } from './generated/constants'
import { absBD } from './helpers'

export function handleZapExecuted(event: ZapExecutedEvent): void {
  let zap = new Zap(`${event.transaction.hash.toHexString()}-${event.logIndex.toString()}`)
  zap.marginAccount = `${event.params._accountOwner.toHexString()}-${event.params._accountNumber.toString()}`
  zap.effectiveUser = getEffectiveUserForAddress(event.params._accountOwner).id
  zap.transaction = event.transaction.hash.toHexString()

  let tokenPath: Array<string> = []
  for (let i = 0; i < event.params._marketIdsPath.length; i++) {
    let marketId = event.params._marketIdsPath[i]
    tokenPath[i] = (TokenMarketIdReverseLookup.load(marketId.toString()) as TokenMarketIdReverseLookup).token
  }
  zap.tokenPath = tokenPath

  let transaction = Transaction.loadInBlock(event.transaction.hash.toHexString()) as Transaction
  let transfers = transaction.transfers.load() as Array<Transfer>

  let tupleArray = [
    ethereum.Value.fromAddress(event.params._accountOwner),
    ethereum.Value.fromUnsignedBigInt(event.params._accountNumber),
    ethereum.Value.fromUnsignedBigInt(event.block.timestamp),
  ]
  let zapAccountId = BigInt.fromByteArray(
    crypto.keccak256(ethereum.encode(ethereum.Value.fromTuple(tupleArray as ethereum.Tuple)) as Bytes)
  )
  let amountInToken: BigDecimal = ZERO_BD
  let amountInUSD: BigDecimal = ZERO_BD
  let amountOutToken: BigDecimal = ZERO_BD
  let amountOutUSD: BigDecimal = ZERO_BD
  for (let i = 0; i < transfers.length; i++) {
    let toMarginAccount = MarginAccount.load(transfers[i].toMarginAccount) as MarginAccount
    let fromMarginAccount = MarginAccount.load(transfers[i].fromMarginAccount) as MarginAccount
    if (toMarginAccount.accountNumber.equals(zapAccountId)) {
      // Transfers into the zap account are the amount in
      amountInToken = absBD(transfers[i].amountDeltaWei)
      amountInUSD = absBD(transfers[i].amountUSDDeltaWei)
    } else if (fromMarginAccount.accountNumber.equals(zapAccountId)) {
      // Transfers out of the zap account are the amount out
      amountOutToken = absBD(transfers[i].amountDeltaWei)
      amountOutUSD = absBD(transfers[i].amountUSDDeltaWei)
    }

    if (amountInToken.notEqual(ZERO_BD) && amountOutToken.notEqual(ZERO_BD)) {
      break
    }
  }

  zap.amountInToken = amountInToken
  zap.amountInUSD = amountInUSD
  zap.amountOutToken = amountOutToken
  zap.amountOutUSD = amountOutUSD
  zap.save()

  for (let i = 0; i < event.params._tradersPath.length; i++) {
    let traderParamEvent = event.params._tradersPath[i]
    let traderParam = new ZapTraderParam(`${zap.id}-${i}`)
    traderParam.zap = zap.id

    if (traderParamEvent.traderType === 0) {
      traderParam.traderType = 'EXTERNAL_LIQUIDITY'
    } else if (traderParamEvent.traderType === 1) {
      traderParam.traderType = 'INTERNAL_LIQUIDITY'
    } else if (traderParamEvent.traderType === 2) {
      traderParam.traderType = 'ISOLATION_MODE_UNWRAPPER'
    } else if (traderParamEvent.traderType === 3) {
      traderParam.traderType = 'ISOLATION_MODE_WRAPPER'
    } else {
      throw new Error(`Invalid trader type, found: ${traderParamEvent.traderType.toString()}`)
    }

    traderParam.traderAddress = traderParamEvent.trader
    traderParam.tradeData = traderParamEvent.tradeData.length === 0 ? null : traderParamEvent.tradeData
    traderParam.save()
  }

  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  dolomiteMargin.zapCount = dolomiteMargin.zapCount.plus(ONE_BI)
  dolomiteMargin.totalZapVolumeUSD = dolomiteMargin.totalZapVolumeUSD.plus(amountInUSD)

  let user = User.load(event.params._accountOwner.toHexString()) as User
  user.totalZapCount = user.totalZapCount.plus(ONE_BI)
  user.totalZapVolumeUSD = user.totalZapVolumeUSD.plus(amountInUSD)
  if (user.effectiveUser != user.id) {
    let effectiveUser = User.load(user.effectiveUser) as User
    effectiveUser.totalZapCount = effectiveUser.totalZapCount.plus(ONE_BI)
    effectiveUser.totalZapVolumeUSD = effectiveUser.totalZapVolumeUSD.plus(amountInUSD)
    effectiveUser.save()
  }
}
