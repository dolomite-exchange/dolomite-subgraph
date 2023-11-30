import { Address } from '@graphprotocol/graph-ts'
import { DolomiteMargin, User } from '../../types/schema'
import { DOLOMITE_MARGIN_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from '../generated/constants'

export function createUserIfNecessary(address: Address): void {
  let user = User.load(address.toHexString())
  if (user === null) {
    user = new User(address.toHexString())
    user.effectiveUser = address.toHexString() // make it self-reflective for now until IsolationMode event fires
    user.totalBorrowVolumeOriginatedUSD = ZERO_BD
    user.totalCollateralLiquidatedUSD = ZERO_BD
    user.totalTradeVolumeUSD = ZERO_BD
    user.totalZapVolumeUSD = ZERO_BD

    user.totalBorrowPositionCount = ZERO_BI
    user.totalLiquidationCount = ZERO_BI
    user.totalMarginPositionCount = ZERO_BI
    user.totalTradeCount = ZERO_BI
    user.totalZapCount = ZERO_BI
    user.isEffectiveUser = true
    user.save()

    let dolomiteMargin = DolomiteMargin.load(DOLOMITE_MARGIN_ADDRESS) as DolomiteMargin
    dolomiteMargin.userCount = dolomiteMargin.userCount.plus(ONE_BI)
    dolomiteMargin.save()
  }
}
