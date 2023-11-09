/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */

import { Address } from '@graphprotocol/graph-ts'

export class LiquidityMiningVestingPositionStatus {
  public static ACTIVE: string = 'ACTIVE'
  public static CLOSED: string = 'CLOSED'
  public static FORCE_CLOSED: string = 'FORCE_CLOSED'
  public static EMERGENCY_CLOSED: string = 'EMERGENCY_CLOSED'
}

export function getLiquidityMiningSeasonId(userAddress: Address, seasonNumber: number): string {
  return `${userAddress.toHexString()}-${seasonNumber}`
}
