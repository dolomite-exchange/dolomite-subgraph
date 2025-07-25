import { BorrowPositionOpen as BorrowPositionOpenEvent } from '../types/BorrowPositionProxy/BorrowPositionProxy'
import {
  BorrowPositionStatus,
  getBorrowPositionId,
  isStrategy,
  parseStrategy,
} from './helpers/borrow-position-helpers'
import {
  BorrowPosition,
  DolomiteMargin,
  StrategyPosition,
  User,
} from '../types/schema'
import { getOrCreateMarginAccount } from './helpers/margin-helpers'
import { getOrCreateTransaction } from './amm-core'
import {
  _100_BI,
  BORROW_POSITION_PROXY_V1_ADDRESS,
  BORROW_POSITION_PROXY_V2_ADDRESS,
  DOLOMITE_MARGIN_ADDRESS,
  EVENT_EMITTER_PROXY_ADDRESS,
  ONE_BI,
} from './generated/constants'
import { Address, ethereum, log } from '@graphprotocol/graph-ts'
import { getEffectiveUserForAddressString } from './helpers/isolation-mode-helpers'

function isContractUnknown(event: ethereum.Event): boolean {
  return event.address.notEqual(Address.fromString(BORROW_POSITION_PROXY_V1_ADDRESS))
    && event.address.notEqual(Address.fromString(BORROW_POSITION_PROXY_V2_ADDRESS))
    && event.address.notEqual(Address.fromString(EVENT_EMITTER_PROXY_ADDRESS))
}

export function handleOpenBorrowPosition(event: BorrowPositionOpenEvent): void {
  if (isContractUnknown(event)) {
    log.warning(
      'handleOpenBorrowPosition: event address does not match BorrowPositionProxy or EventEmitterRegistry address',
      [],
    )
    return
  }
  if (event.params.accountIndex.lt(_100_BI)) {
    log.warning(
      'handleOpenBorrowPosition: attempted to open a borrow position within a Dolomite Balance',
      [],
    )
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

    if (isStrategy(marginAccount)) {
      let strategyObject = parseStrategy(marginAccount)

      let strategy = new StrategyPosition(borrowPosition.id)
      strategy.effectiveUser = borrowPosition.effectiveUser
      strategy.marginAccount = marginAccount.id
      strategy.strategyId = strategyObject.strategyId
      strategy.positionId = strategyObject.positionId
      strategy.save()

      borrowPosition.strategy = strategy.id
    }
    // Save once we set the strategy
    borrowPosition.save()

    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    dolomiteMargin.borrowPositionCount = dolomiteMargin.borrowPositionCount.plus(ONE_BI)
    dolomiteMargin.save()
  }
}
