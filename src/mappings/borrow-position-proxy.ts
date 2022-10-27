import {
  BorrowPositionOpen as BorrowPositionOpenEvent,
} from '../types/BorrowPositionProxy/BorrowPositionProxy'
import { BorrowPositionStatus, getBorrowPositionId } from './borrow-position-helpers'
import { BorrowPosition, DolomiteMargin, User } from '../types/schema'
import { getOrCreateMarginAccount } from './margin-helpers'
import { getOrCreateTransaction } from './amm-core'
import { DOLOMITE_MARGIN_ADDRESS, ONE_BI } from './generated/constants'


export function handleOpenBorrowPosition(event: BorrowPositionOpenEvent): void {
  let id = getBorrowPositionId(event.params.accountOwner, event.params.accountIndex)
  let borrowPosition = BorrowPosition.load(id)
  if (borrowPosition == null) {
    let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountIndex, event.block)
    marginAccount.save()

    let user = User.load(event.params.accountOwner.toHexString()) as User
    user.totalBorrowPositionCount = user.totalBorrowPositionCount.plus(ONE_BI)
    user.save()

    borrowPosition = new BorrowPosition(id)
    borrowPosition.marginAccount = marginAccount.id
    borrowPosition.openTimestamp = event.block.timestamp
    borrowPosition.openTransaction = getOrCreateTransaction(event).id
    borrowPosition.status = BorrowPositionStatus.Open
    borrowPosition.amounts = []
    borrowPosition.save()

    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    dolomiteMargin.borrowPositionCount = dolomiteMargin.borrowPositionCount.plus(ONE_BI)
    dolomiteMargin.save()
  }
}
