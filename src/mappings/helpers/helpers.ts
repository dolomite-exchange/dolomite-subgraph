import { BigDecimal } from '@graphprotocol/graph-ts'
import { ZERO_BD } from '../generated/constants'
import { InterestIndex, InterestIndexSnapshot } from '../../types/schema'

export function absBD(bd: BigDecimal): BigDecimal {
  if (bd.lt(ZERO_BD)) {
    return bd.neg()
  } else {
    return bd
  }
}

export function getOrCreateInterestIndexSnapshotAndReturnId(interestIndex: InterestIndex): string {
  let snapshotId = `${interestIndex.token}-${interestIndex.lastUpdate.toString()}`
  let snapshot = InterestIndexSnapshot.loadInBlock(snapshotId)
  if (snapshot === null) {
    snapshot = InterestIndexSnapshot.load(snapshotId)
    if (snapshot === null) {
      snapshot = new InterestIndexSnapshot(snapshotId)
      snapshot.token = interestIndex.token
      snapshot.borrowIndex = interestIndex.borrowIndex
      snapshot.supplyIndex = interestIndex.supplyIndex
      snapshot.updateTimestamp = interestIndex.lastUpdate
      snapshot.save()
    }
  }
  return snapshot.id
}
