import {
  MarginPositionClose as MarginPositionCloseEvent,
  MarginPositionOpen as MarginPositionOpenEvent
} from '../types/DolomiteAmmRouter/DolomiteAmmRouterProxy'
import { DolomiteMargin as DolomiteMarginProtocol } from '../types/DolomiteAmmRouter/DolomiteMargin'
import { MarginPositionStatus, PositionChangeEvent, ValueStruct } from './margin-types'
import { InterestIndex, MarginAccount, MarginPosition, Token } from '../types/schema'
import { Address, BigDecimal } from '@graphprotocol/graph-ts/index'
import { DOLOMITE_MARGIN_ADDRESS } from './generated/constants'
import { absBD, convertStructToDecimal, ZERO_BD } from './amm-helpers'
import { getTokenOraclePriceUSD } from './amm-pricing'
import {
  getOrCreateMarginAccount,
  getOrCreateMarginPosition,
  getOrCreateTokenValue,
  isMarginPositionExpired
} from './margin-helpers'

function updateMarginPositionForTrade(
  marginPosition: MarginPosition,
  event: PositionChangeEvent,
  dolomiteMarginProtocol: DolomiteMarginProtocol,
  inputTokenNewPar: ValueStruct,
  outputTokenNewPar: ValueStruct,
  inputTokenIndex: InterestIndex,
  outputTokenIndex: InterestIndex
): void {
  let isPositionBeingOpened = false
  if (marginPosition.owedToken === null || marginPosition.heldToken === null) {
    // the position is being opened
    isPositionBeingOpened = true
    marginPosition.owedToken = event.inputToken.id
    marginPosition.heldToken = event.outputToken.id
  }

  if (!isPositionBeingOpened) {
    let tokens = [marginPosition.heldToken, marginPosition.owedToken]
    if (
      marginPosition.status == MarginPositionStatus.Unknown ||
      !tokens.includes(event.inputToken.id) ||
      !tokens.includes(event.outputToken.id) ||
      !tokens.includes(event.depositToken.id)
    ) {
      // the position is invalidated
      marginPosition.status = MarginPositionStatus.Unknown
      marginPosition.save()
      return
    }
  }

  let heldToken: Token = Token.load(marginPosition.heldToken as string) as Token
  let owedToken: Token = Token.load(marginPosition.owedToken as string) as Token

  const heldTokenNewPar = marginPosition.heldToken == event.inputToken.id ?
    absBD(convertStructToDecimal(inputTokenNewPar, heldToken.decimals)) :
    absBD(convertStructToDecimal(outputTokenNewPar, heldToken.decimals))

  const owedTokenNewPar = marginPosition.owedToken == event.inputToken.id ?
    absBD(convertStructToDecimal(inputTokenNewPar, owedToken.decimals)) :
    absBD(convertStructToDecimal(outputTokenNewPar, owedToken.decimals))

  let heldTokenIndex = marginPosition.heldToken == event.inputToken.id ? inputTokenIndex : outputTokenIndex
  let owedTokenIndex = marginPosition.owedToken == event.inputToken.id ? inputTokenIndex : outputTokenIndex

  // if the trader is closing the position, they are sizing down the collateral and debt
  let inputAmountWei = !event.isOpen ? event.inputWei.neg() : event.inputWei
  let outputAmountWei = !event.isOpen ? event.outputWei.neg() : event.outputWei

  let heldAmountWei = marginPosition.heldToken == event.inputToken.id ? inputAmountWei : outputAmountWei
  let owedAmountWei = marginPosition.owedToken == event.inputToken.id ? inputAmountWei : outputAmountWei

  marginPosition.owedAmountPar = owedTokenNewPar
  marginPosition.heldAmountPar = heldTokenNewPar

  if (isPositionBeingOpened) {
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken)
    let heldPriceUSD = getTokenOraclePriceUSD(heldToken)

    marginPosition.initialOwedAmountPar = owedTokenNewPar
    marginPosition.initialOwedAmountWei = owedAmountWei
    marginPosition.initialOwedPrice = absBD(heldAmountWei).div(absBD(owedAmountWei)).truncate(36)
    marginPosition.initialOwedPriceUSD = marginPosition.initialOwedPrice.times(heldPriceUSD).truncate(36)
    marginPosition.initialOwedAmountUSD = owedAmountWei.times(marginPosition.initialOwedPriceUSD).truncate(36)

    marginPosition.initialHeldAmountPar = heldTokenNewPar
    marginPosition.initialHeldAmountWei = heldAmountWei
    if (marginPosition.heldToken == event.depositToken.id) {
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(event.depositWei)
    }
    marginPosition.initialHeldPrice = absBD(owedAmountWei).div(absBD(heldAmountWei)).truncate(36)
    marginPosition.initialHeldPriceUSD = marginPosition.initialHeldPrice.times(owedPriceUSD).truncate(36)
    marginPosition.initialHeldAmountUSD = marginPosition.initialHeldAmountWei.times(marginPosition.initialHeldPriceUSD).truncate(36)

    marginPosition.marginDeposit = event.depositWei
    marginPosition.marginDepositUSD = event.depositWei.times(marginPosition.initialHeldPriceUSD)
  }


  if (marginPosition.owedAmountPar.equals(ZERO_BD)) {
    marginPosition.status = isMarginPositionExpired(marginPosition, event) ? MarginPositionStatus.Expired : MarginPositionStatus.Closed
    marginPosition.closeTimestamp = event.timestamp
    marginPosition.closeTransaction = event.hash.toHexString()

    let heldPriceUSD = getTokenOraclePriceUSD(heldToken)
    let owedPriceUSD = getTokenOraclePriceUSD(owedToken)

    marginPosition.closeHeldPrice = owedAmountWei.div(heldAmountWei).truncate(18)
    marginPosition.closeHeldPriceUSD = (marginPosition.closeHeldPrice as BigDecimal).times(owedPriceUSD).truncate(36)
    marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldTokenIndex.supplyIndex)
    marginPosition.closeHeldAmountUSD = (marginPosition.closeHeldAmountWei as BigDecimal).times(heldPriceUSD).truncate(36)
    marginPosition.closeHeldAmountSeized = ZERO_BD
    marginPosition.closeHeldAmountSeizedUSD = ZERO_BD

    marginPosition.closeOwedPrice = heldAmountWei.div(owedAmountWei).truncate(18)
    marginPosition.closeOwedPriceUSD = (marginPosition.closeOwedPrice as BigDecimal).times(heldPriceUSD).truncate(36)
    marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex.borrowIndex)
    marginPosition.closeOwedAmountUSD = (marginPosition.closeOwedAmountWei as BigDecimal).times(owedPriceUSD).truncate(36)
  }

  let tokenValue = getOrCreateTokenValue(MarginAccount.load(marginPosition.marginAccount) as MarginAccount, owedToken)
  if (tokenValue.expirationTimestamp !== null) {
    marginPosition.expirationTimestamp = tokenValue.expirationTimestamp
  }

  marginPosition.save()
}

export function handleMarginPositionOpen(event: MarginPositionOpenEvent): void {
  let marginAccount = getOrCreateMarginAccount(event.params.user, event.params.accountIndex, event.block)
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
    event.transaction.hash
  )
  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.marketId.toString()) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.marketId.toString()) as InterestIndex

  updateMarginPositionForTrade(marginPosition, positionChangeEvent, marginProtocol, inputBalanceUpdate, outputBalanceUpdate, inputIndex, outputIndex)
  marginPosition.save()
}

export function handleMarginPositionClose(event: MarginPositionCloseEvent): void {
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
    event.transaction.hash
  )
  let marginProtocol = DolomiteMarginProtocol.bind(Address.fromString(DOLOMITE_MARGIN_ADDRESS))
  let inputBalanceUpdate = new ValueStruct(event.params.inputBalanceUpdate.newPar)
  let outputBalanceUpdate = new ValueStruct(event.params.outputBalanceUpdate.newPar)
  let inputIndex = InterestIndex.load(positionChangeEvent.inputToken.marketId.toString()) as InterestIndex
  let outputIndex = InterestIndex.load(positionChangeEvent.outputToken.marketId.toString()) as InterestIndex

  updateMarginPositionForTrade(marginPosition, positionChangeEvent, marginProtocol, inputBalanceUpdate, outputBalanceUpdate, inputIndex, outputIndex)
  marginPosition.save()
}
