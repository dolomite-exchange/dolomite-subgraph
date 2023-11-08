/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */
import { Address, Bytes } from '@graphprotocol/graph-ts'

export class AsyncDepositStatus {
  public static CREATED: string = 'CREATED'
  public static DEPOSIT_EXECUTED: string = 'DEPOSIT_EXECUTED'
  public static DEPOSIT_FAILED: string = 'DEPOSIT_FAILED'
  public static DEPOSIT_CANCELLED: string = 'DEPOSIT_CANCELLED'
  public static DEPOSIT_CANCELLED_FAILED: string = 'DEPOSIT_CANCELLED_FAILED'
}

export class AsyncWithdrawalStatus {
  public static CREATED: string = 'CREATED'
  public static WITHDRAWAL_EXECUTED: string = 'WITHDRAWAL_EXECUTED'
  public static WITHDRAWAL_EXECUTION_FAILED: string = 'WITHDRAWAL_EXECUTION_FAILED'
  public static WITHDRAWAL_CANCELLED: string = 'WITHDRAWAL_CANCELLED'
}


export function getAsyncDepositOrWithdrawalKey(token: Address, key: Bytes): string {
  return `${token.toHexString()}-${key.toHexString()}`
}
