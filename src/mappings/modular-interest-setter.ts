/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { DolomiteMargin, InterestIndex, InterestRate, Token, TotalPar } from '../types/schema'
import { DOLOMITE_MARGIN_ADDRESS } from './generated/constants'
import {
  SettingsChanged as ModularInterestRateSettingsChangedEvent,
} from '../types/ModularLinearStepInterestSetter/ModularLinearStepFunctionInterestSetter'
import { updateInterestRate } from './interest-setter'

export function handleModularInterestSettingsChanged(
  settingsChangedEvent: ModularInterestRateSettingsChangedEvent,
): void {
  let tokenId = settingsChangedEvent.params.token.toHexString()
  let interestRate = InterestRate.load(tokenId)
  if (interestRate !== null && interestRate.interestSetter.equals(settingsChangedEvent.address)) {
    interestRate.lowerOptimalRate = settingsChangedEvent.params.lowerOptimalPercent
    interestRate.upperOptimalRate = settingsChangedEvent.params.upperOptimalPercent
    interestRate.optimalUtilizationRate = settingsChangedEvent.params.optimalUtilization
    interestRate.save()

    let totalPar = TotalPar.load(tokenId) as TotalPar
    let index = InterestIndex.load(tokenId) as InterestIndex
    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    updateInterestRate(Token.load(tokenId) as Token, totalPar, index, dolomiteMargin)
  }
}
