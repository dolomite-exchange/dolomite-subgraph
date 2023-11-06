import {
  AsyncDepositCreated as AsyncDepositCreatedEvent,
  AsyncDepositExecuted as AsyncDepositExecutedEvent,
  AsyncDepositFailed as AsyncDepositFailedEvent,
  AsyncDepositCancelled as AsyncDepositCancelledEvent,
  AsyncDepositCancelledFailed as AsyncDepositCancelledFailedEvent,
  AsyncWithdrawalCreated as AsyncWithdrawalCreatedEvent,
  AsyncWithdrawalExecuted as AsyncWithdrawalExecutedEvent,
  AsyncWithdrawalFailed as AsyncWithdrawalFailedEvent,
  AsyncWithdrawalCancelled as AsyncWithdrawalCancelledEvent,
} from '../types/EventEmitterRegistry/EventEmitterRegistry'

export function handleAsyncDepositCreated(event: AsyncDepositCreatedEvent): void {
  // TODO
}

export function handleAsyncDepositExecuted(event: AsyncDepositExecutedEvent): void {
  // TODO
}

export function handleAsyncDepositFailed(event: AsyncDepositFailedEvent): void {
  // TODO
}

export function handleAsyncDepositCancelled(event: AsyncDepositCancelledEvent): void {
  // TODO
}

export function handleAsyncDepositCancelledFailed(event: AsyncDepositCancelledFailedEvent): void {
  // TODO
}

export function handleAsyncWithdrawalCreated(event: AsyncWithdrawalCreatedEvent): void {
  // TODO
}

export function handleAsyncWithdrawalExecuted(event: AsyncWithdrawalExecutedEvent): void {
  // TODO
}

export function handleAsyncWithdrawalFailed(event: AsyncWithdrawalFailedEvent): void {
  // TODO
}

export function handleAsyncWithdrawalCancelled(event: AsyncWithdrawalCancelledEvent): void {
  // TODO
}
