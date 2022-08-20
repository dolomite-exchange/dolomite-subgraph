import {
  BorrowPositionOpen as BorrowPositionOpenEvent,
} from '../types/BorrowPositionProxy/BorrowPositionProxy'
import { BorrowPositionStatus, getBorrowPositionId } from './borrow-position-helpers'
import { BorrowPosition } from '../types/schema'
import { getOrCreateMarginAccount } from './margin-helpers'
import { getOrCreateTransaction } from './amm-core'


export function handleOpenBorrowPosition(event: BorrowPositionOpenEvent): void {
  let id = getBorrowPositionId(event.params.accountOwner, event.params.accountIndex)
  let borrowPosition = BorrowPosition.load(id)
  if (borrowPosition == null) {
    let marginAccount = getOrCreateMarginAccount(event.params.accountOwner, event.params.accountIndex, event.block)
    marginAccount.save()

    borrowPosition = new BorrowPosition(id)
    borrowPosition.marginAccount = marginAccount.id
    borrowPosition.openTimestamp = event.block.timestamp
    borrowPosition.openTransaction = getOrCreateTransaction(event).id
    borrowPosition.status = BorrowPositionStatus.Open
    borrowPosition.save()
  }
}
