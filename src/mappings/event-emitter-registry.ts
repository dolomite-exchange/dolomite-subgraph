import {
  Address,
  ethereum,
  log,
} from '@graphprotocol/graph-ts'
import {
  AsyncDepositCancelled as AsyncDepositCancelledEvent,
  AsyncDepositCancelledFailed as AsyncDepositCancelledFailedEvent,
  AsyncDepositCreated as AsyncDepositCreatedEvent,
  AsyncDepositExecuted as AsyncDepositExecutedEvent,
  AsyncDepositFailed as AsyncDepositFailedEvent,
  AsyncDepositOutputAmountUpdated as AsyncDepositOutputAmountUpdatedEvent,
  AsyncWithdrawalCancelled as AsyncWithdrawalCancelledEvent,
  AsyncWithdrawalCreated as AsyncWithdrawalCreatedEvent,
  AsyncWithdrawalExecuted as AsyncWithdrawalExecutedEvent,
  AsyncWithdrawalFailed as AsyncWithdrawalFailedEvent,
  AsyncWithdrawalOutputAmountUpdated as AsyncWithdrawalOutputAmountUpdatedEvent,
  DistributorRegistered as DistributorRegisteredEvent,
  RewardClaimed as RewardClaimedEvent,
} from '../types/EventEmitterRegistry/EventEmitterRegistry'
import {
  AsyncDeposit,
  AsyncWithdrawal,
  LiquidityMiningVester,
  Token,
} from '../types/schema'
import {
  EVENT_EMITTER_FROM_CORE_ADDRESS,
  EVENT_EMITTER_PROXY_ADDRESS,
  ZERO_BI,
} from './generated/constants'
import {
  AsyncDepositStatus,
  AsyncWithdrawalStatus,
  getAsyncDepositOrWithdrawalKey,
} from './helpers/event-emitter-registry-helpers'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import { handleClaim } from './helpers/liquidity-mining-helpers'
import { getOrCreateMarginAccount } from './helpers/margin-helpers'
import { convertTokenToDecimal } from './helpers/token-helpers'

function requireIsValidEventEmitter(event: ethereum.Event): boolean {
  let isValid = event.address.equals(Address.fromHexString(EVENT_EMITTER_PROXY_ADDRESS)) ||
    event.address.equals(Address.fromHexString(EVENT_EMITTER_FROM_CORE_ADDRESS))
  if (!isValid) {
    log.info('Invalid event emitter, found {}', [event.address.toHexString()])
    return false
  }

  return true
}

export function handleAsyncDepositCreated(event: AsyncDepositCreatedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = new AsyncDeposit(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key))
  let inputToken = Token.load(event.params.deposit.inputToken.toHexString()) as Token
  let outputToken = Token.load(event.params.token.toHexString()) as Token

  let marginAccount = getOrCreateMarginAccount(
    event.params.deposit.vault,
    event.params.deposit.accountNumber,
    event.block,
  )
  let effectiveUser = getEffectiveUserForAddress(event.params.deposit.vault)

  deposit.key = event.params.key
  deposit.marginAccount = marginAccount.id
  deposit.effectiveUser = effectiveUser.id
  deposit.status = AsyncDepositStatus.CREATED
  deposit.inputToken = inputToken.id
  deposit.inputAmount = convertTokenToDecimal(event.params.deposit.inputAmount, inputToken.decimals)
  deposit.outputToken = outputToken.id
  deposit.minOutputAmount = convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals)
  deposit.outputAmount = convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals)
  deposit.isRetryable = event.params.deposit.isRetryable
  deposit.save()
}

export function handleAsyncDepositOutputAmountUpdated(event: AsyncDepositOutputAmountUpdatedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  let outputToken = Token.load(deposit.outputToken) as Token
  deposit.outputAmount = convertTokenToDecimal(event.params.outputAmount, outputToken.decimals)
  deposit.save()
}

export function handleAsyncDepositExecuted(event: AsyncDepositExecutedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.status = AsyncDepositStatus.DEPOSIT_EXECUTED
  deposit.save()
}

export function handleAsyncDepositFailed(event: AsyncDepositFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.status = AsyncDepositStatus.DEPOSIT_FAILED
  deposit.save()
}

export function handleAsyncDepositCancelled(event: AsyncDepositCancelledEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.status = AsyncDepositStatus.DEPOSIT_CANCELLED
  deposit.isRetryable = false
  deposit.save()
}

export function handleAsyncDepositCancelledFailed(event: AsyncDepositCancelledFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.status = AsyncDepositStatus.DEPOSIT_CANCELLED_FAILED
  deposit.isRetryable = true
  deposit.save()
}

export function handleAsyncWithdrawalCreated(event: AsyncWithdrawalCreatedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = new AsyncWithdrawal(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key))
  let inputToken = Token.load(event.params.token.toHexString()) as Token
  let outputToken = Token.load(event.params.withdrawal.outputToken.toHexString()) as Token

  let marginAccount = getOrCreateMarginAccount(
    event.params.withdrawal.vault,
    event.params.withdrawal.accountNumber,
    event.block,
  )
  let effectiveUser = getEffectiveUserForAddress(event.params.withdrawal.vault)

  withdrawal.key = event.params.key
  withdrawal.marginAccount = marginAccount.id
  withdrawal.effectiveUser = effectiveUser.id
  withdrawal.status = AsyncWithdrawalStatus.CREATED
  withdrawal.inputToken = inputToken.id
  withdrawal.inputAmount = convertTokenToDecimal(event.params.withdrawal.inputAmount, inputToken.decimals)
  withdrawal.outputToken = outputToken.id
  withdrawal.minOutputAmount = convertTokenToDecimal(event.params.withdrawal.outputAmount, outputToken.decimals)
  withdrawal.outputAmount = convertTokenToDecimal(event.params.withdrawal.outputAmount, outputToken.decimals)
  withdrawal.isRetryable = event.params.withdrawal.isRetryable
  withdrawal.isLiquidation = event.params.withdrawal.isLiquidation
  withdrawal.extraData = event.params.withdrawal.extraData
  withdrawal.save()
}

export function handleAsyncWithdrawalOutputAmountUpdated(event: AsyncWithdrawalOutputAmountUpdatedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = AsyncWithdrawal.load(getAsyncDepositOrWithdrawalKey(
    event.params.token,
    event.params.key,
  )) as AsyncWithdrawal
  let outputToken = Token.load(withdrawal.outputToken) as Token
  withdrawal.outputAmount = convertTokenToDecimal(event.params.outputAmount, outputToken.decimals)
  withdrawal.save()
}

export function handleAsyncWithdrawalExecuted(event: AsyncWithdrawalExecutedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = AsyncWithdrawal.load(getAsyncDepositOrWithdrawalKey(
    event.params.token,
    event.params.key,
  )) as AsyncWithdrawal
  withdrawal.status = AsyncWithdrawalStatus.WITHDRAWAL_EXECUTED
  withdrawal.isRetryable = false
  withdrawal.save()
}

export function handleAsyncWithdrawalFailed(event: AsyncWithdrawalFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = AsyncWithdrawal.load(getAsyncDepositOrWithdrawalKey(
    event.params.token,
    event.params.key,
  )) as AsyncWithdrawal
  withdrawal.status = AsyncWithdrawalStatus.WITHDRAWAL_EXECUTION_FAILED
  withdrawal.isRetryable = true
  withdrawal.save()
}

export function handleAsyncWithdrawalCancelled(event: AsyncWithdrawalCancelledEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = AsyncWithdrawal.load(getAsyncDepositOrWithdrawalKey(
    event.params.token,
    event.params.key,
  )) as AsyncWithdrawal
  withdrawal.status = AsyncWithdrawalStatus.WITHDRAWAL_CANCELLED
  withdrawal.isRetryable = false
  withdrawal.save()
}

const seasonNumber = ZERO_BI

export function handleRewardClaimed(event: RewardClaimedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  handleClaim(event.params.distributor, event.params.user, event.params.epoch, seasonNumber, event.params.amount)
}

export function handleDistributorRegistered(event: DistributorRegisteredEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let vester = new LiquidityMiningVester(event.address.toHexString())
  vester.oTokenAddress = event.params.oTokenAddress
  vester.pairToken = event.params.pairToken.toHexString()
  vester.paymentToken = event.params.paymentToken.toHexString()
  vester.save()
}
