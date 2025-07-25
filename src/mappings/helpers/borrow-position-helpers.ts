import {
  Address,
  BigInt,
  ethereum,
} from '@graphprotocol/graph-ts'
import {
  BorrowPosition,
  BorrowPositionAmount,
  MarginAccount,
  Token,
} from '../../types/schema'
import { getOrCreateTransaction } from '../amm-core'
import {
  STRATEGY_ID_THRESHOLD,
  STRATEGY_LOWER_ACCOUNT_ID,
  STRATEGY_POSITION_ID_THRESHOLD,
  STRATEGY_UPPER_ACCOUNT_ID,
  ZERO_BD,
} from '../generated/constants'
import { getOrCreateTokenValue } from './margin-helpers'
import { BalanceUpdate } from './margin-types'

export class BorrowPositionStatus {
  // eslint-disable-next-line
  static Open: string = 'OPEN'
  // eslint-disable-next-line
  static Closed: string = 'CLOSED'

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
  if (borrowPositionAmount === null) {
    borrowPositionAmount = new BorrowPositionAmount(id)
    borrowPositionAmount.token = token.id
    borrowPositionAmount.amountWei = ZERO_BD
    borrowPositionAmount.amountPar = ZERO_BD
    borrowPositionAmount.expirationTimestamp = null
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

    index = borrowPosition.allTokens.indexOf(borrowPositionAmount.token)
    if (index != -1) {
      let copy = borrowPosition.allTokens
      copy.splice(index, 1)
      borrowPosition.allTokens = copy
      updated = true
    }

    if (borrowPositionAmount.amountPar.gt(ZERO_BD)) {
      index = borrowPosition.supplyTokens.indexOf(borrowPositionAmount.token)
      if (index != -1) {
        let copy = borrowPosition.supplyTokens
        copy.splice(index, 1)
        borrowPosition.supplyTokens = copy
        updated = true
      }
    } else {
      index = borrowPosition.borrowTokens.indexOf(borrowPositionAmount.token)
      if (index != -1) {
        let copy = borrowPosition.borrowTokens
        copy.splice(index, 1)
        borrowPosition.borrowTokens = copy
        updated = true
      }
    }

  } else if (borrowPositionAmount.amountPar.equals(ZERO_BD) && !balanceUpdate.valuePar.equals(ZERO_BD)) {
    // The user is going from not having a balance to having one. Add to the list
    borrowPosition.amounts = borrowPosition.amounts.concat([borrowPositionAmount.id])

    borrowPosition.allTokens = borrowPosition.allTokens.concat([borrowPositionAmount.token])

    if (balanceUpdate.valuePar.gt(ZERO_BD)) {
      borrowPosition.supplyTokens = borrowPosition.supplyTokens.concat([borrowPositionAmount.token])
      if (borrowPosition.effectiveSupplyTokens.indexOf(borrowPositionAmount.token) == -1) {
        borrowPosition.effectiveSupplyTokens = borrowPosition.effectiveSupplyTokens.concat([borrowPositionAmount.token])
      }
    } else {
      borrowPosition.borrowTokens = borrowPosition.borrowTokens.concat([borrowPositionAmount.token])
      if (borrowPosition.effectiveBorrowTokens.indexOf(borrowPositionAmount.token) == -1) {
        borrowPosition.effectiveBorrowTokens = borrowPosition.effectiveBorrowTokens.concat([borrowPositionAmount.token])
      }
    }

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
    let isPositionEmptyBefore = isAmountsEmpty(position)
    updateBorrowAndSupplyTokens(position, marginAccount, balanceUpdate)
    if (isAmountsEmpty(position) && position.status != BorrowPositionStatus.Closed) {
      position.status = BorrowPositionStatus.Closed
      position.closeTimestamp = event.block.timestamp
      position.closeTransaction = getOrCreateTransaction(event).id
      position.save()
    } else if (isPositionEmptyBefore && !isAmountsEmpty(position)) {
      // the user reopened the position... not sure why they would want to do this, but whatever.
      position.status = BorrowPositionStatus.Open
      position.closeTimestamp = null
      position.closeTransaction = null
      position.save()
    }
  }
}

// noinspection JSUnusedLocalSymbols
export function updateBorrowPositionForLiquidation(
  marginAccount: MarginAccount,
  event: ethereum.Event, // eslint-disable-line
): void {
  let id = getBorrowPositionId(Address.fromString(marginAccount.user), marginAccount.accountNumber)
  let position = BorrowPosition.load(id)
  if (position !== null) {
    // The borrow and supply tokens are updated in the updateBorrowPositionForBalanceUpdate function
    // Do nothing for now.
  }
}

export function isStrategy(marginAccount: MarginAccount): boolean {
  return marginAccount.accountNumber.ge(STRATEGY_LOWER_ACCOUNT_ID) &&
    marginAccount.accountNumber.le(STRATEGY_UPPER_ACCOUNT_ID)
}

export class ParsedStrategy {
  constructor(public readonly strategyId: BigInt, public readonly positionId: BigInt) {}
}

export function parseStrategy(marginAccount: MarginAccount): ParsedStrategy {
  let fullPositionId = marginAccount.accountNumber
  const positionId = fullPositionId.mod(STRATEGY_POSITION_ID_THRESHOLD)
  const remainingValue = fullPositionId.minus(positionId)
    .div(STRATEGY_POSITION_ID_THRESHOLD)
  const strategyId = remainingValue.minus(STRATEGY_ID_THRESHOLD)
  return new ParsedStrategy(strategyId, positionId)
}
