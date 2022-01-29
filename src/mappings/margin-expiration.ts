import {
  Address,
  log
} from '@graphprotocol/graph-ts/index'
import { DolomiteMargin as DolomiteMarginProtocol } from '../types/MarginExpiry/DolomiteMargin'
import {
  ExpirySet as ExpirySetEvent,
  LogExpiryRampTimeSet as ExpiryRampTimeSetEvent,
} from '../types/MarginExpiry/DolomiteMarginExpiry'
import { Token } from '../types/schema'
import {
  DOLOMITE_MARGIN_ADDRESS,
  ZERO_BD,
  ZERO_BI
} from './generated/constants'
import {
  getOrCreateDolomiteMarginForCall,
  getOrCreateMarginAccount,
  getOrCreateMarginPosition,
  getOrCreateTokenValue
} from './margin-helpers'
import {
  MarginPositionStatus,
  ProtocolType
} from './margin-types'

// noinspection JSUnusedGlobalSymbols
export function handleSetExpiry(event: ExpirySetEvent): void {
  log.info(
    'Handling expiration set for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let params = event.params
  let marginAccount = getOrCreateMarginAccount(event.params.owner, event.params.number, event.block)
  if (event.params.time.equals(ZERO_BI)) {
    // remove the market ID
    let index = marginAccount.expirationMarketIds.indexOf(event.params.marketId)
    if (index != -1) {
      marginAccount.expirationMarketIds = marginAccount.expirationMarketIds.splice(index, 1)
    }
    marginAccount.hasExpiration = marginAccount.expirationMarketIds.length > 0
  } else {
    // add the market ID, if necessary
    let index = marginAccount.expirationMarketIds.indexOf(event.params.marketId)
    if (index == -1) {
      marginAccount.expirationMarketIds = marginAccount.expirationMarketIds.concat([event.params.marketId])
    }
    marginAccount.hasExpiration = true
  }
  marginAccount.save()

  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  if (marginPosition.marginDeposit.notEqual(ZERO_BD) && marginPosition.status == MarginPositionStatus.Open) {
    if (params.time.equals(ZERO_BI)) {
      marginPosition.expirationTimestamp = null
    } else {
      marginPosition.expirationTimestamp = params.time
    }
    marginPosition.save()
  }

  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let tokenAddress = marginProtocol.getMarketTokenAddress(event.params.marketId)
    .toHexString()
  let token = Token.load(tokenAddress) as Token

  let tokenValue = getOrCreateTokenValue(marginAccount, token)
  tokenValue.expirationTimestamp = event.params.time.gt(ZERO_BI) ? event.params.time : null
  tokenValue.expiryAddress = event.params.time.gt(ZERO_BI) ? event.address.toHexString() : null
  tokenValue.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleSetExpiryRampTime(event: ExpiryRampTimeSetEvent): void {
  log.info(
    'Handling expiration ramp time set for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Expiry)
  dolomiteMargin.expiryRampTime = event.params.expiryRampTime
  dolomiteMargin.save()
}
