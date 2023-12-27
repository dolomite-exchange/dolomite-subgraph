import { Address, BigDecimal, ethereum, log } from '@graphprotocol/graph-ts'
import {
  MarginPositionClose as MarginPositionCloseEvent,
  MarginPositionOpen as MarginPositionOpenEvent,
} from '../types/DolomiteAmmRouter/DolomiteAmmRouterProxy'
import {
  BorrowPosition,
  DolomiteMargin,
  InterestIndex,
  MarginAccount,
  MarginPosition,
  Token,
  User,
} from '../types/schema'
import { convertStructToDecimalAppliedValue } from './helpers/amm-helpers'
import {
  DOLOMITE_AMM_ROUTER_PROXY_V1_ADDRESS,
  DOLOMITE_AMM_ROUTER_PROXY_V2_ADDRESS,
  DOLOMITE_MARGIN_ADDRESS,
  EVENT_EMITTER_PROXY_ADDRESS,
  ONE_BI,
  USD_PRECISION,
  ZERO_BD,
} from './generated/constants'
import { absBD } from './helpers/helpers'
import { getOrCreateMarginAccount, getOrCreateMarginPosition, getOrCreateTokenValue } from './helpers/margin-helpers'
import { MarginPositionStatus, PositionChangeEvent, ProtocolType, ValueStruct } from './helpers/margin-types'
import { getTokenOraclePriceUSD } from './helpers/pricing'

function updateMarginPositionForTrade(
  marginPosition: MarginPosition,
  event: ethereum.Event,
  positionChangeEvent: PositionChangeEvent,
  inputTokenNewPar: ValueStruct,
  outputTokenNewPar: ValueStruct,
  inputTokenIndex: InterestIndex,
  outputTokenIndex: InterestIndex,
): void {
  let isPositionBeingOpened = false
  if (marginPosition.owedToken === null || marginPosition.heldToken === null) {
    // the position is being opened
    isPositionBeingOpened = true
    marginPosition.owedToken = positionChangeEvent.inputToken.id
    marginPosition.heldToken = positionChangeEvent.outputToken.id
  }

  if (!isPositionBeingOpened) {
    let tokens = [marginPosition.heldToken, marginPosition.owedToken]
    if (
      marginPosition.status == MarginPositionStatus.Unknown ||
      !tokens.includes(positionChangeEvent.inputToken.id) ||
      !tokens.includes(positionChangeEvent.outputToken.id) ||
      !tokens.includes(positionChangeEvent.depositToken.id)
    ) {
      // the position is invalidated
      marginPosition.status = MarginPositionStatus.Unknown
      marginPosition.save()
      return
    }
  }

  let heldToken: Token = Token.load(marginPosition.heldToken as string) as Token
  let owedToken: Token = Token.load(marginPosition.owedToken as string) as Token

  const heldTokenNewPar = marginPosition.heldToken == positionChangeEvent.inputToken.id ?
    absBD(convertStructToDecimalAppliedValue(inputTokenNewPar, heldToken.decimals)) :
    absBD(convertStructToDecimalAppliedValue(outputTokenNewPar, heldToken.decimals))

  const owedTokenNewPar = marginPosition.owedToken == positionChangeEvent.inputToken.id ?
    absBD(convertStructToDecimalAppliedValue(inputTokenNewPar, owedToken.decimals)) :
    absBD(convertStructToDecimalAppliedValue(outputTokenNewPar, owedToken.decimals))

  let heldTokenIndex = marginPosition.heldToken == positionChangeEvent.inputToken.id
    ? inputTokenIndex
    : outputTokenIndex
  let owedTokenIndex = marginPosition.owedToken == positionChangeEvent.inputToken.id
    ? inputTokenIndex
    : outputTokenIndex

  // if the trader is closing the position, they are sizing down the collateral and debt
  let inputAmountWei = !positionChangeEvent.isOpen
    ? positionChangeEvent.inputWei.neg()
    : positionChangeEvent.inputWei
  let outputAmountWei = !positionChangeEvent.isOpen
    ? positionChangeEvent.outputWei.neg()
    : positionChangeEvent.outputWei

  let heldAmountWei = marginPosition.heldToken == positionChangeEvent.inputToken.id ? inputAmountWei : outputAmountWei
  let owedAmountWei = marginPosition.owedToken == positionChangeEvent.inputToken.id ? inputAmountWei : outputAmountWei

  marginPosition.owedAmountPar = owedTokenNewPar
  marginPosition.heldAmountPar = heldTokenNewPar

  if (isPositionBeingOpened) {
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Position)
    let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Position)

    marginPosition.initialOwedAmountPar = owedTokenNewPar
    marginPosition.initialOwedAmountWei = owedAmountWei
    marginPosition.initialOwedPrice = absBD(heldAmountWei)
      .div(absBD(owedAmountWei))
      .truncate(18)
    marginPosition.initialOwedPriceUSD = marginPosition.initialOwedPrice.times(heldPriceUSD)
      .truncate(36)
    marginPosition.initialOwedAmountUSD = owedAmountWei.times(marginPosition.initialOwedPriceUSD)
      .truncate(36)

    marginPosition.initialHeldAmountPar = heldTokenNewPar
    marginPosition.initialHeldAmountWei = heldAmountWei.plus(positionChangeEvent.depositWei)
    marginPosition.initialHeldPrice = absBD(owedAmountWei)
      .div(absBD(heldAmountWei))
      .truncate(18)
    marginPosition.initialHeldPriceUSD = marginPosition.initialHeldPrice.times(owedPriceUSD)
      .truncate(USD_PRECISION)
    marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountWei.times(marginPosition.initialHeldPriceUSD)
      .truncate(USD_PRECISION)

    // set the margin deposit here and the initial held amount. We do it here, because the `isInitialized` GUARD
    // STATEMENT executes, disallowing the initial values to be set when the position is opened
    marginPosition.marginDeposit = positionChangeEvent.depositWei
    marginPosition.marginDepositUSD = positionChangeEvent.depositWei.times(marginPosition.initialHeldPriceUSD)
      .truncate(USD_PRECISION)

    // Needs to be initialized
    marginPosition.initialMarginDeposit = positionChangeEvent.depositWei
    marginPosition.initialMarginDepositUSD = positionChangeEvent.depositWei.times(marginPosition.initialHeldPriceUSD)
      .truncate(USD_PRECISION)

    marginPosition.isInitialized = true
  }


  if (marginPosition.owedAmountPar.equals(ZERO_BD)) {
    marginPosition.status = MarginPositionStatus.Closed
    marginPosition.closeTimestamp = positionChangeEvent.timestamp
    marginPosition.closeTransaction = positionChangeEvent.hash.toHexString()

    let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Position)
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Position)

    marginPosition.closeHeldPrice = owedAmountWei.div(heldAmountWei)
      .truncate(18)
    marginPosition.closeHeldPriceUSD = (marginPosition.closeHeldPrice as BigDecimal).times(owedPriceUSD)
      .truncate(USD_PRECISION)
    marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldTokenIndex.supplyIndex)
    marginPosition.closeHeldAmountUSD = (marginPosition.closeHeldAmountWei as BigDecimal).times(heldPriceUSD)
      .truncate(USD_PRECISION)
    marginPosition.closeHeldAmountSeized = ZERO_BD
    marginPosition.closeHeldAmountSeizedUSD = ZERO_BD

    marginPosition.closeOwedPrice = heldAmountWei.div(owedAmountWei)
      .truncate(18)
    marginPosition.closeOwedPriceUSD = (marginPosition.closeOwedPrice as BigDecimal).times(heldPriceUSD)
      .truncate(36)
    marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex.borrowIndex)
    marginPosition.closeOwedAmountUSD = (marginPosition.closeOwedAmountWei as BigDecimal).times(owedPriceUSD)
      .truncate(36)
  }

  let tokenValue = getOrCreateTokenValue(MarginAccount.load(marginPosition.marginAccount) as MarginAccount, owedToken)
  if (tokenValue.expirationTimestamp !== null) {
    marginPosition.expirationTimestamp = tokenValue.expirationTimestamp
  }

  marginPosition.save()
}

function isContractUnknown(event: ethereum.Event): boolean {
  return event.address.notEqual(Address.fromHexString(DOLOMITE_AMM_ROUTER_PROXY_V1_ADDRESS))
    && event.address.notEqual(Address.fromHexString(DOLOMITE_AMM_ROUTER_PROXY_V2_ADDRESS))
    && event.address.notEqual(Address.fromHexString(EVENT_EMITTER_PROXY_ADDRESS))
}

// noinspection JSUnusedGlobalSymbols
export function handleMarginPositionOpen(event: MarginPositionOpenEvent): void {
  if (isContractUnknown(event)) {
    log.warning('Ignoring event from unknown contract: {}', [event.address.toHexString()])
    return
  }
  let borrowPosition = BorrowPosition.load(
    `${event.params.user.toHexString()}-${event.params.accountIndex.toString()}`,
  )
  if (borrowPosition !== null) {
    log.debug('Ignoring event because it is a borrow position: {}', [event.transaction.hash.toHexString()])
    return
  }

  let marginAccount = getOrCreateMarginAccount(event.params.user, event.params.accountIndex, event.block)

  let user = User.load(event.params.user.toHexString()) as User
  user.totalMarginPositionCount = user.totalMarginPositionCount.plus(ONE_BI)
  user.save()
  if (user.effectiveUser != user.id) {
    let effectiveUser = User.load(user.effectiveUser) as User
    effectiveUser.totalMarginPositionCount = effectiveUser.totalMarginPositionCount.plus(ONE_BI)
    effectiveUser.save()
  }

  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  let positionChangeEvent = new PositionChangeEvent(
    event.params.user,
    event.params.accountIndex,
    Token.load(event.params.inputToken.toHexString()) as Token,
    Token.load(event.params.outputToken.toHexString()) as Token,
    Token.load(event.params.depositToken.toHexString()) as Token,
    event.params.inputBalanceUpdate.deltaWei.value,
    event.params.outputBalanceUpdate.deltaWei.value,
    event.params.marginDepositUpdate.deltaWei.value,
    true,
    event.block.number,
    event.block.timestamp,
    event.transaction.hash,
  )
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.id) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.id) as InterestIndex

  updateMarginPositionForTrade(
    marginPosition,
    event,
    positionChangeEvent,
    inputBalanceUpdate,
    outputBalanceUpdate,
    inputIndex,
    outputIndex,
  )
  marginPosition.save()

  let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
  dolomiteMargin.marginPositionCount = dolomiteMargin.marginPositionCount.plus(ONE_BI)
  dolomiteMargin.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleMarginPositionClose(event: MarginPositionCloseEvent): void {
  if (isContractUnknown(event)) {
    log.warning('Ignoring event from unknown contract: {}', [event.address.toHexString()])
    return
  }
  let borrowPosition = BorrowPosition.load(
    `${event.params.user.toHexString()}-${event.params.accountIndex.toString()}`,
  )
  if (borrowPosition !== null) {
    log.debug('Ignoring event because it is a borrow position: {}', [event.transaction.hash.toHexString()])
    return
  }

  let marginAccount = getOrCreateMarginAccount(event.params.user, event.params.accountIndex, event.block)
  let marginPosition = getOrCreateMarginPosition(event, marginAccount)
  let positionChangeEvent = new PositionChangeEvent(
    event.params.user,
    event.params.accountIndex,
    Token.load(event.params.inputToken.toHexString()) as Token,
    Token.load(event.params.outputToken.toHexString()) as Token,
    Token.load(event.params.withdrawalToken.toHexString()) as Token,
    event.params.inputBalanceUpdate.deltaWei.value,
    event.params.outputBalanceUpdate.deltaWei.value,
    event.params.marginWithdrawalUpdate.deltaWei.value,
    false,
    event.block.number,
    event.block.timestamp,
    event.transaction.hash,
  )
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.id) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.id) as InterestIndex

  updateMarginPositionForTrade(
    marginPosition,
    event,
    positionChangeEvent,
    inputBalanceUpdate,
    outputBalanceUpdate,
    inputIndex,
    outputIndex,
  )
  marginPosition.save()
}
