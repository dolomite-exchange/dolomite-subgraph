import { Address, BigDecimal, ethereum, log } from '@graphprotocol/graph-ts'
import { ZapExecuted as ZapExecutedEvent } from '../types/Zap/GenericTraderProxy'
import {
  DolomiteMargin,
  MarginAccount,
  Transaction,
  Transfer,
  User,
  Zap,
  ZapTraderParam,
} from '../types/schema'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import {
  DOLOMITE_MARGIN_ADDRESS,
  EVENT_EMITTER_PROXY_ADDRESS,
  GENERIC_TRADER_PROXY_V1,
  ONE_BI,
  ZERO_BD,
} from './generated/constants'
import { absBD } from './helpers/helpers'
import { getTokenPathForZap, getZapAccountNumber } from './helpers/zap-helpers'

function isContractUnknown(event: ethereum.Event): boolean {
  return event.address.notEqual(Address.fromString(GENERIC_TRADER_PROXY_V1))
    && event.address.notEqual(Address.fromString(EVENT_EMITTER_PROXY_ADDRESS))
}

export function handleZapExecuted(event: ZapExecutedEvent): void {
  if (isContractUnknown(event)) {
    log.warning(
      'handleZapExecuted: event address does not match GenericTraderProxyV1 or EventEmitterRegistry address',
      [],
    )
    return
  }

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
  for (let i = 0; i < event.params.tradersPath.length; i++) {
    let traderParamEvent = event.params.tradersPath[i]
    let traderParam = new ZapTraderParam(`${zap.id}-${i}`)
    traderParam.zap = zap.id

    if (traderParamEvent.traderType == 0) {
      traderParam.traderType = 'EXTERNAL_LIQUIDITY'
    } else if (traderParamEvent.traderType == 1) {
      traderParam.traderType = 'INTERNAL_LIQUIDITY'
    } else if (traderParamEvent.traderType == 2) {
      traderParam.traderType = 'ISOLATION_MODE_UNWRAPPER'
    } else if (traderParamEvent.traderType == 3) {
      traderParam.traderType = 'ISOLATION_MODE_WRAPPER'
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
