/* eslint-disable @typescript-eslint/no-inferrable-types,@typescript-eslint/camelcase */
import { Address, BigInt, Bytes } from '@graphprotocol/graph-ts'
import { EventEmitterRegistry as EventEmitterRegistryTemplate } from '../../types/templates'
import { EVENT_EMITTER_FROM_CORE_ADDRESS, EVENT_EMITTER_PROXY_ADDRESS } from '../generated/constants'

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

export function getRewardClaimerKey(distributor: Address, user: Address, epoch: BigInt): string {
  return `${distributor.toHexString()}-${user.toHexString()}-${epoch.toString()}`
}

export function createEventEmitterRegistries(): void {
  EventEmitterRegistryTemplate.create(Address.fromString(EVENT_EMITTER_PROXY_ADDRESS))
  EventEmitterRegistryTemplate.create(Address.fromString(EVENT_EMITTER_FROM_CORE_ADDRESS))
}
