/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { log } from '@graphprotocol/graph-ts'
import {
  ExpirySet as ExpirySetEvent,
  LogExpiryRampTimeSet as ExpiryRampTimeSetEvent
} from '../types/MarginExpiry/DolomiteMarginExpiry'
import {
  Token,
  TokenMarketIdReverseMap
} from '../types/schema'
import {
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

  let tokenAddress = TokenMarketIdReverseMap.load(event.params.marketId.toString())!.token
  let token = Token.load(tokenAddress) as Token

  let marginAccount = getOrCreateMarginAccount(event.params.owner, event.params.number, event.block)
  if (event.params.time.equals(ZERO_BI)) {
    // remove the market ID
    let index = marginAccount.expirationTokens.indexOf(token.id)
    if (index != -1) {
      let copy = marginAccount.expirationTokens
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      marginAccount.expirationTokens = copy
    }
    marginAccount.hasExpiration = marginAccount.expirationTokens.length > 0
  } else {
    // add the market ID, if necessary
    let index = marginAccount.expirationTokens.indexOf(token.id)
    if (index == -1) {
      marginAccount.expirationTokens = marginAccount.expirationTokens.concat([token.id])
    }
    marginAccount.hasExpiration = true
  }
  marginAccount.save()

  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  if (marginPosition.marginDeposit.notEqual(ZERO_BD) && marginPosition.status == MarginPositionStatus.Open) {
    if (event.params.time.equals(ZERO_BI)) {
      marginPosition.expirationTimestamp = null
    } else {
      marginPosition.expirationTimestamp = event.params.time
    }
    marginPosition.save()
  }

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
