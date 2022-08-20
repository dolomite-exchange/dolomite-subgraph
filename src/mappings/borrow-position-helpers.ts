import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { BorrowPosition, MarginAccount, Token } from '../types/schema'
import { BalanceUpdate } from './margin-types'
import { ZERO_BD } from './generated/constants'
import { getOrCreateTokenValue } from './margin-helpers'
import { getOrCreateTransaction } from './amm-core'

export class BorrowPositionStatus {
  // eslint-disable-next-line
  static Open: string = 'OPEN'
  // eslint-disable-next-line
  static Closed: string = 'CLOSED'
  // eslint-disable-next-line
  static Liquidated: string = 'LIQUIDATED'

  static isClosed(position: BorrowPosition): boolean {
    return position.status != BorrowPositionStatus.Open
  }
}

export function getBorrowPositionId(accountOwner: Address, accountIndex: BigInt): string {
  return `${accountOwner.toHexString()}-${accountIndex.toString()}`
}

function updateBorrowAndSupplyTokens(
  borrowPosition: BorrowPosition,
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate
): void {
  let tokenValue = getOrCreateTokenValue(marginAccount, balanceUpdate.token)
  let updated = false

  // borrow tokens
  if (tokenValue.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.ge(ZERO_BD)) {
    // The user is going from a negative balance to a positive one. Remove from the list
    let index = borrowPosition.borrowTokens.indexOf(balanceUpdate.token.id)
    if (index != -1) {
      let copy = borrowPosition.borrowTokens
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      borrowPosition.borrowTokens = copy
      updated = true
    }
  } else if (tokenValue.valuePar.ge(ZERO_BD) && balanceUpdate.valuePar.lt(ZERO_BD)) {
    // The user is going from a positive balance to a negative one, add it to the borrow list
    borrowPosition.borrowTokens = borrowPosition.borrowTokens.concat([balanceUpdate.token.id])
    updated = true
  }

  // Supply tokens
  if (tokenValue.valuePar.gt(ZERO_BD) && balanceUpdate.valuePar.le(ZERO_BD)) {
    // The user is going from a positive balance to 0 or a negative one. Remove from the list
    let index = borrowPosition.supplyTokens.indexOf(balanceUpdate.token.id)
    if (index != -1) {
      let copy = borrowPosition.supplyTokens
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      borrowPosition.supplyTokens = copy
      updated = true
    }
  } else if (tokenValue.valuePar.ge(ZERO_BD) && balanceUpdate.valuePar.lt(ZERO_BD)) {
    // The user is going from a negative or 0 balance to a positive one, add it to the supply list
    borrowPosition.supplyTokens = borrowPosition.supplyTokens.concat([balanceUpdate.token.id])
    updated = true
  }

  if (updated) {
    borrowPosition.save()
  }
}

function isTokenArraysEmpty(borrowPosition: BorrowPosition): boolean {
  return borrowPosition.borrowTokens.length == 0 && borrowPosition.supplyTokens.length == 0
}

export function updateBorrowPositionForBalanceUpdate(
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate,
  event: ethereum.Event
): void {
  let id = getBorrowPositionId(Address.fromString(marginAccount.user), marginAccount.accountNumber)
  let position = BorrowPosition.load(id)
  if (position != null) {
    updateBorrowAndSupplyTokens(position, marginAccount, balanceUpdate)
    if (position.status === BorrowPositionStatus.Open && isTokenArraysEmpty(position)) {
      position.status = BorrowPositionStatus.Closed
      position.closeTimestamp = event.block.timestamp
      position.closeTransaction = getOrCreateTransaction(event).id
      position.save()
    }
  }
}

export function updateBorrowPositionForLiquidation(
  marginAccount: MarginAccount,
  event: ethereum.Event
): void {
  let id = getBorrowPositionId(Address.fromString(marginAccount.user), marginAccount.accountNumber)
  let position = BorrowPosition.load(id)
  if (position != null) {
    // The borrow and supply tokens are updated in the updateBorrowPositionForBalanceUpdate function
    position.status = BorrowPositionStatus.Liquidated
    position.closeTimestamp = event.block.timestamp
    position.closeTransaction = getOrCreateTransaction(event).id
    position.save()
  }
}
