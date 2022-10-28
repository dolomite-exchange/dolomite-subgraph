import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { BorrowPosition, BorrowPositionAmount, MarginAccount, Token } from '../types/schema'
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

export function getBorrowPositionAmountId(accountOwner: Address, accountIndex: BigInt, token: Token): string {
  return `${getBorrowPositionId(accountOwner, accountIndex)}-${token.id}`
}

function getOrCreateBorrowPositionAmount(marginAccount: MarginAccount, token: Token): BorrowPositionAmount {
  let id = getBorrowPositionAmountId(Address.fromString(marginAccount.user), marginAccount.accountNumber, token)
  let borrowPositionAmount = BorrowPositionAmount.load(id)
  if (borrowPositionAmount == null) {
    borrowPositionAmount = new BorrowPositionAmount(id)
    borrowPositionAmount.token = token.id
    borrowPositionAmount.amountWei = ZERO_BD
    borrowPositionAmount.amountPar = ZERO_BD
  }
  return borrowPositionAmount as BorrowPositionAmount
}

function updateBorrowAndSupplyTokens(
  borrowPosition: BorrowPosition,
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate,
): void {
  let tokenValue = getOrCreateTokenValue(marginAccount, balanceUpdate.token)
  let updated = false
  let borrowPositionAmount = getOrCreateBorrowPositionAmount(marginAccount, balanceUpdate.token)

  if (!borrowPositionAmount.amountPar.equals(ZERO_BD) && balanceUpdate.valuePar.equals(ZERO_BD)) {
    // The user is going from having a balance to not having one. Remove from the list
    let index = borrowPosition.amounts.indexOf(borrowPositionAmount.id)
    if (index != -1) {
      let copy = borrowPosition.amounts
      copy.splice(index, 1)
      // NOTE we must use the copy here because the return value of #splice isn't the new array. Rather, it returns the
      // DELETED element only
      borrowPosition.amounts = copy
      updated = true
    }
  } else if (borrowPositionAmount.amountPar.equals(ZERO_BD) && !balanceUpdate.valuePar.equals(ZERO_BD)) {
    // The user is going from not having a balance to having one. Add to the list
    borrowPosition.amounts = borrowPosition.amounts.concat([borrowPositionAmount.id])
    updated = true
  }

  borrowPositionAmount.amountPar = tokenValue.valuePar
  borrowPositionAmount.amountWei = borrowPositionAmount.amountWei.plus(balanceUpdate.deltaWei)
  borrowPositionAmount.save()

  if (updated) {
    borrowPosition.save()
  }
}

function isAmountsEmpty(borrowPosition: BorrowPosition): boolean {
  return borrowPosition.amounts.length == 0
}

export function updateBorrowPositionForBalanceUpdate(
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate,
  event: ethereum.Event,
): void {
  let id = getBorrowPositionId(Address.fromString(marginAccount.user), marginAccount.accountNumber)
  let position = BorrowPosition.load(id)
  if (position !== null) {
    updateBorrowAndSupplyTokens(position, marginAccount, balanceUpdate)
    if (position.status == BorrowPositionStatus.Open && isAmountsEmpty(position)) {
      position.status = BorrowPositionStatus.Closed
      position.closeTimestamp = event.block.timestamp
      position.closeTransaction = getOrCreateTransaction(event).id
      position.save()
    }
  }
}

export function updateBorrowPositionForLiquidation(
  marginAccount: MarginAccount,
  event: ethereum.Event,
): void {
  let id = getBorrowPositionId(Address.fromString(marginAccount.user), marginAccount.accountNumber)
  let position = BorrowPosition.load(id)
  if (position !== null) {
    // The borrow and supply tokens are updated in the updateBorrowPositionForBalanceUpdate function
    position.status = BorrowPositionStatus.Liquidated
    position.closeTimestamp = event.block.timestamp
    position.closeTransaction = getOrCreateTransaction(event).id
    position.save()
  }
}
