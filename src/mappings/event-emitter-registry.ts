import { Address, ethereum, log } from '@graphprotocol/graph-ts'
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
  DolomiteSettingChanged as DolomiteSettingChangedEvent,
  RewardClaimed as RewardClaimedEvent,
  TokenSettingChanged as TokenSettingChangedEvent,
  UserSettingChanged as UserSettingChangedEvent,
} from '../types/templates/EventEmitterRegistry/EventEmitterRegistry'
import {
  AsyncDeposit,
  AsyncWithdrawal,
  DolomiteSetting,
  LiquidityMiningVester,
  Token,
  TokenSetting, UserSetting,
} from '../types/schema'
import { EVENT_EMITTER_FROM_CORE_ADDRESS, EVENT_EMITTER_PROXY_ADDRESS, ZERO_BI } from './generated/constants'
import {
  AsyncDepositStatus,
  AsyncWithdrawalStatus,
  getAsyncDepositOrWithdrawalKey,
} from './helpers/event-emitter-registry-helpers'
import { getEffectiveUserForAddress } from './helpers/isolation-mode-helpers'
import { handleClaim } from './helpers/liquidity-mining-helpers'
import { getOrCreateMarginAccount } from './helpers/margin-helpers'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { LiquidityMiningVester as LiquidityMiningVesterTemplate } from '../types/templates'
import { getOrCreateTransaction } from './amm-core'
import { TradeLiquidationType } from './helpers/helpers'
import { createUserIfNecessary } from './helpers/user-helpers'

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

  deposit.creationTransaction = getOrCreateTransaction(event).id
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
  deposit.executionTransaction = getOrCreateTransaction(event).id
  deposit.status = AsyncDepositStatus.DEPOSIT_EXECUTED
  deposit.save()
}

export function handleAsyncDepositFailed(event: AsyncDepositFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.executionTransaction = getOrCreateTransaction(event).id
  deposit.status = AsyncDepositStatus.DEPOSIT_FAILED
  deposit.save()
}

export function handleAsyncDepositCancelled(event: AsyncDepositCancelledEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.executionTransaction = getOrCreateTransaction(event).id
  deposit.status = AsyncDepositStatus.DEPOSIT_CANCELLED
  deposit.isRetryable = false
  deposit.save()
}

export function handleAsyncDepositCancelledFailed(event: AsyncDepositCancelledFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let deposit = AsyncDeposit.load(getAsyncDepositOrWithdrawalKey(event.params.token, event.params.key)) as AsyncDeposit
  deposit.executionTransaction = getOrCreateTransaction(event).id
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
  withdrawal.creationTransaction = getOrCreateTransaction(event).id
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
  let transaction = getOrCreateTransaction(event)

  withdrawal.executionTransaction = transaction.id
  withdrawal.status = AsyncWithdrawalStatus.WITHDRAWAL_EXECUTED
  withdrawal.isRetryable = false
  withdrawal.save()

  if (withdrawal.isLiquidation) {
    let trades = transaction.trades.load()
    for (let i = 0; i < trades.length; i++) {
      let trade = trades[i]
      if (
        (trade.takerToken == withdrawal.inputToken && trade.makerToken == withdrawal.outputToken) ||
        (trade.makerToken == withdrawal.inputToken && trade.takerToken == withdrawal.outputToken)
      ) {
        trade.liquidationType = TradeLiquidationType.LIQUIDATION
        trade.save()
      }
    }
  }
}

export function handleAsyncWithdrawalFailed(event: AsyncWithdrawalFailedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let withdrawal = AsyncWithdrawal.load(getAsyncDepositOrWithdrawalKey(
    event.params.token,
    event.params.key,
  )) as AsyncWithdrawal
  withdrawal.executionTransaction = getOrCreateTransaction(event).id
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
  withdrawal.executionTransaction = getOrCreateTransaction(event).id
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

  let vester = new LiquidityMiningVester(event.params.vesterContract.toHexString())
  vester.oTokenAddress = event.params.oTokenAddress
  vester.pairToken = event.params.pairToken.toHexString()
  vester.paymentToken = event.params.paymentToken.toHexString()
  vester.save()

  LiquidityMiningVesterTemplate.create(event.params.vesterContract)
}

export function handleDolomiteSettingChanged(event: DolomiteSettingChangedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let dolomiteAddressString = event.address.toHexString()
  let settingIdString = event.params.settingId.toHexString()
  let settings = DolomiteSetting.load(`${dolomiteAddressString}-${settingIdString}`)
  if (settings === null) {
    settings = new DolomiteSetting(`${dolomiteAddressString}-${settingIdString}`)
    settings.dolomite = event.address.toHexString()
    settings.key = event.params.settingId
  }
  settings.value = event.params.value.toHexString()
  settings.save()
}


export function handleUserSettingChanged(event: UserSettingChangedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  createUserIfNecessary(event.params.user)

  let userAddress = event.params.user.toHexString()
  let settingIdString = event.params.settingId.toHexString()
  let settings = UserSetting.load(`${userAddress}-${settingIdString}`)
  if (settings === null) {
    settings = new UserSetting(`${userAddress}-${settingIdString}`)
    settings.effectiveUser = userAddress
    settings.key = event.params.settingId
  }
  settings.value = event.params.value.toHexString()
  settings.save()
}


export function handleTokenSettingChanged(event: TokenSettingChangedEvent): void {
  if (!requireIsValidEventEmitter(event)) {
    return
  }

  let tokenAddress = event.params.token.toHexString()
  let settingIdString = event.params.settingId.toHexString()
  let settings = TokenSetting.load(`${tokenAddress}-${settingIdString}`)
  if (settings === null) {
    settings = new TokenSetting(`${tokenAddress}-${settingIdString}`)
    settings.token = tokenAddress
    settings.key = event.params.settingId
  }
  settings.value = event.params.value.toHexString()
  settings.save()
}
