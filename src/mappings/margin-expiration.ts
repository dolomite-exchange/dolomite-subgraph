import { ExpirySet as ExpirySetEvent } from '../types/MarginExpiry/DolomiteMarginExpiry'
import { Address, log } from '@graphprotocol/graph-ts/index'
import { getOrCreateMarginAccount, getOrCreateMarginPosition, getOrCreateTokenValue } from './margin-helpers'
import { ZERO_BD, ZERO_BI } from './amm-helpers'
import { MarginPositionStatus } from './margin-types'
import { DolomiteMargin as DolomiteMarginProtocol } from '../types/MarginExpiry/DolomiteMargin'
import { DOLOMITE_MARGIN_ADDRESS } from './generated/constants'
import { Token } from '../types/schema'

export function handleSetExpiry(event: ExpirySetEvent): void {
  log.info(
    'Handling expiration set for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()]
  )

  let params = event.params
  let marginAccount = getOrCreateMarginAccount(event.params.owner, event.params.number, event.block)
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
  let tokenAddress = marginProtocol.getMarketTokenAddress(event.params.marketId).toHexString()
  let token = Token.load(tokenAddress) as Token

  let tokenValue = getOrCreateTokenValue(marginAccount, token)
  if (tokenValue.expirationTimestamp !== null && event.params.time.equals(ZERO_BI)) {
    // The user is going from having an expiration to not having one, remove
    let index = marginAccount.expirationMarketIds.indexOf(tokenValue.id)
    if (index != -1) {
      let arrayCopy = marginAccount.expirationMarketIds
      arrayCopy.splice(index, 1)
      marginAccount.expirationMarketIds = arrayCopy
    }
  } else if (tokenValue.expirationTimestamp === null && event.params.time.gt(ZERO_BI)) {
    // The user is going from having no expiration to having one, add it to the list
    marginAccount.expirationMarketIds = marginAccount.expirationMarketIds.concat([tokenValue.id])
  }
  marginAccount.hasExpiration = marginAccount.expirationMarketIds.length > 0

  tokenValue.expirationTimestamp = event.params.time.gt(ZERO_BI) ? event.params.time : null
  tokenValue.expiryAddress = event.params.time.gt(ZERO_BI) ? event.address.toHexString() : null
  tokenValue.save()
}
