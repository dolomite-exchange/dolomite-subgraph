import {
  BorrowPositionOpen as BorrowPositionOpenEvent,
} from '../types/BorrowPositionProxy/BorrowPositionProxy'
import { BorrowPositionStatus, getBorrowPositionId } from './borrow-position-helpers'
import { BorrowPosition, DolomiteMargin, User } from '../types/schema'
import { getOrCreateMarginAccount } from './margin-helpers'
import { getOrCreateTransaction } from './amm-core'
import {
  BORROW_POSITION_PROXY_V1_ADDRESS,
  BORROW_POSITION_PROXY_V2_ADDRESS,
  DOLOMITE_MARGIN_ADDRESS,
  ONE_BI,
} from './generated/constants'
import { Address, log } from '@graphprotocol/graph-ts'
import { getEffectiveUserForAddressString } from './isolation-mode-helpers'

export function handleOpenBorrowPosition(event: BorrowPositionOpenEvent): void {
  if (
    event.address.notEqual(Address.fromString(BORROW_POSITION_PROXY_V1_ADDRESS))
    && event.address.notEqual(Address.fromString(BORROW_POSITION_PROXY_V2_ADDRESS))
  ) {
    log.warning('handleOpenBorrowPosition: event address does not match any known BorrowPositionProxy address', [])
    return
  }

  let id = getBorrowPositionId(event.params.accountOwner, event.params.accountIndex)
  let borrowPosition = BorrowPosition.load(id)
  if (borrowPosition === null) {
    let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountIndex, event.block)
    marginAccount.save()

    let user = User.load(event.params.accountOwner.toHexString()) as User
    user.totalBorrowPositionCount = user.totalBorrowPositionCount.plus(ONE_BI)
    user.save()
    if (user.effectiveUser != user.id) {
      let effectiveUser = User.load(user.effectiveUser) as User
      effectiveUser.totalBorrowPositionCount = effectiveUser.totalBorrowPositionCount.plus(ONE_BI)
      effectiveUser.save()
    }

    borrowPosition = new BorrowPosition(id)
    borrowPosition.effectiveUser = getEffectiveUserForAddressString(marginAccount.user).id
    borrowPosition.marginAccount = marginAccount.id
    borrowPosition.openTimestamp = event.block.timestamp
    borrowPosition.openTransaction = getOrCreateTransaction(event).id
    borrowPosition.status = BorrowPositionStatus.Open
    borrowPosition.amounts = []
    borrowPosition.allTokens = []
    borrowPosition.borrowTokens = []
    borrowPosition.supplyTokens = []
    borrowPosition.effectiveBorrowTokens = []
    borrowPosition.effectiveSupplyTokens = []
    borrowPosition.save()

    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    dolomiteMargin.borrowPositionCount = dolomiteMargin.borrowPositionCount.plus(ONE_BI)
    dolomiteMargin.save()
  }
}
