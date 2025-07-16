/* eslint-disable */
import { Address, BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import {
  LogBuy as BuyEvent,
  LogCall as CallEvent,
  LogDeposit as DepositEvent,
  LogIndexUpdate as IndexUpdateEventOld,
  LogIndexUpdate1 as IndexUpdateEventNew,
  LogLiquidate as LiquidationEvent,
  LogOperation as OperationEvent,
  LogOraclePrice as OraclePriceEvent,
  LogSell as SellEvent,
  LogTrade as TradeEvent,
  LogTransfer as TransferEvent,
  LogVaporize as VaporizationEvent,
  LogWithdraw as WithdrawEvent,
} from '../types/MarginCore/DolomiteMargin'
import {
  Deposit,
  InterestIndex,
  IntermediateTrade,
  Liquidation,
  MarginPosition,
  OraclePrice,
  Token,
  TokenMarketIdReverseLookup,
  Trade,
  Transfer,
  User,
  Vaporization,
  Withdrawal,
} from '../types/schema'
import { getOrCreateTransaction } from './amm-core'
import { _18_BI, EXPIRY_ADDRESS, ONE_BI, USD_PRECISION, ZERO_BD, ZERO_BI } from './generated/constants'
import { convertStructToDecimalAppliedValue } from './helpers/amm-helpers'
import { updateBorrowPositionForLiquidation } from './helpers/borrow-position-helpers'
import { absBD, getOrCreateInterestIndexSnapshotAndReturnId, TradeLiquidationType } from './helpers/helpers'
import { getEffectiveUserForAddress, getEffectiveUserForAddressString } from './helpers/isolation-mode-helpers'
import {
  canBeMarginPosition,
  changeProtocolBalance,
  changeProtocolBalanceApplied,
  getIDForEvent,
  getLiquidationSpreadForPair,
  getOrCreateDolomiteMarginForCall,
  getOrCreateMarginPosition,
  handleDolomiteMarginBalanceUpdateForAccount,
  MarginAccountWithValueParChange,
  parToWei,
  roundHalfUp,
  saveMostRecentTrade,
  updateMarginPositionForTransfer,
} from './helpers/margin-helpers'
import { BalanceUpdate, MarginPositionStatus, ProtocolType, ValueStruct } from './helpers/margin-types'
import { getTokenOraclePriceUSD } from './helpers/pricing'
import { convertTokenToDecimal } from './helpers/token-helpers'
import { updateAndSaveVolumeForTrade } from './helpers/volume-helpers'

// noinspection JSUnusedGlobalSymbols,JSUnusedLocalSymbols
export function handleOperation(event: OperationEvent): void {
  // do nothing as of now
}

// noinspection JSUnusedGlobalSymbols
export function handleIndexUpdateOld(event: IndexUpdateEventOld): void {
  handleIndexUpdate(
    event,
    event.params.market,
    event.params.index.borrow,
    event.params.index.supply,
    event.params.index.lastUpdate,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleIndexUpdateNew(event: IndexUpdateEventNew): void {
  handleIndexUpdate(
    event,
    event.params.market,
    event.params.index.borrow,
    event.params.index.supply,
    event.params.index.lastUpdate,
  )
}

function handleIndexUpdate(
  event: ethereum.Event,
  marketId: BigInt,
  borrowIndex: BigInt,
  supplyIndex: BigInt,
  lastUpdate: BigInt,
): void {
  log.info(
    'Handling index update for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(marketId.toString())!.token
  let index = InterestIndex.load(tokenAddress)
  if (index === null) {
    index = new InterestIndex(tokenAddress)
  }

  index.borrowIndex = convertTokenToDecimal(borrowIndex, _18_BI)
  index.supplyIndex = convertTokenToDecimal(supplyIndex, _18_BI)
  index.lastUpdate = lastUpdate
  index.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleOraclePriceUpdate(event: OraclePriceEvent): void {
  log.info(
    'Handling oracle price update for block hash, hash and index: {}-{}-{}',
    [event.block.hash.toHexString(), event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let tokenAddress = TokenMarketIdReverseLookup.load(event.params.market.toString())!.token
  let token = Token.load(tokenAddress) as Token
  let oraclePrice = OraclePrice.load(tokenAddress) as OraclePrice

  oraclePrice.price = convertTokenToDecimal(
    event.params.price.value,
    BigInt.fromI32(36 - token.decimals.toI32()),
  )
  oraclePrice.blockNumber = event.block.number
  oraclePrice.blockHash = event.block.hash
  oraclePrice.save()

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, false, ProtocolType.Core)

  changeProtocolBalance(
    event,
    token,
    ValueStruct.fromFields(false, ZERO_BI),
    InterestIndex.load(token.id) as InterestIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleDeposit(event: DepositEvent): void {
  log.info(
    'Handling deposit for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let token = Token.load(TokenMarketIdReverseLookup.load(event.params.market.toString())!.token) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    event.params.update.deltaWei.value,
    event.params.update.deltaWei.sign,
    token,
  )
  let accountUpdateOne = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let depositID = getIDForEvent(event)
  let deposit = Deposit.load(depositID)
  if (deposit === null) {
    deposit = new Deposit(depositID)
    deposit.serialId = dolomiteMargin.actionCount
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let marketIndex = InterestIndex.load(token.id) as InterestIndex

  deposit.transaction = transaction.id
  deposit.logIndex = event.logIndex
  deposit.effectiveUser = getEffectiveUserForAddress(event.params.accountOwner).id
  deposit.marginAccount = accountUpdateOne.marginAccount.id
  deposit.token = token.id
  deposit.interestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketIndex)
  deposit.from = event.params.from
  deposit.amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals)
  deposit.amountDeltaPar = accountUpdateOne.deltaPar
  deposit.amountUSDDeltaWei = deposit.amountDeltaWei.times(getTokenOraclePriceUSD(token, event, ProtocolType.Core))
    .truncate(USD_PRECISION)

  dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei)

  let isVirtualTransfer = false
  changeProtocolBalance(
    event,
    token,
    deltaWeiStruct,
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  accountUpdateOne.marginAccount.save()
  deposit.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleWithdraw(event: WithdrawEvent): void {
  log.info(
    'Handling withdrawal for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let token = Token.load(TokenMarketIdReverseLookup.load(event.params.market.toString())!.token) as Token

  let balanceUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    event.params.update.deltaWei.value,
    event.params.update.deltaWei.sign,
    token,
  )
  let accountUpdateOne = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate, event)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let withdrawalID = getIDForEvent(event)
  let withdrawal = Withdrawal.load(withdrawalID)
  if (withdrawal === null) {
    withdrawal = new Withdrawal(withdrawalID)
    withdrawal.serialId = dolomiteMargin.actionCount
  }

  let deltaWeiStruct = new ValueStruct(event.params.update.deltaWei)
  let deltaWeiStructAbs = deltaWeiStruct.abs()
  let marketIndex = InterestIndex.load(token.id) as InterestIndex

  withdrawal.transaction = transaction.id
  withdrawal.logIndex = event.logIndex
  withdrawal.effectiveUser = getEffectiveUserForAddress(event.params.accountOwner).id
  withdrawal.marginAccount = accountUpdateOne.marginAccount.id
  withdrawal.token = token.id
  withdrawal.interestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketIndex)
  withdrawal.to = event.params.to
  withdrawal.amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStructAbs, token.decimals)
  withdrawal.amountDeltaPar = accountUpdateOne.deltaPar
  withdrawal.amountUSDDeltaWei = withdrawal.amountDeltaWei
    .times(getTokenOraclePriceUSD(token, event, ProtocolType.Core))
    .truncate(USD_PRECISION)

  accountUpdateOne.marginAccount.save()
  withdrawal.save()

  let isVirtualTransfer = false
  changeProtocolBalance(
    event,
    token,
    deltaWeiStruct,
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleTransfer(event: TransferEvent): void {
  log.info(
    'Handling transfer for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let token = Token.load(TokenMarketIdReverseLookup.load(event.params.market.toString())!.token) as Token

  let balanceUpdate1 = new BalanceUpdate(
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign,
    event.params.updateOne.deltaWei.value,
    event.params.updateOne.deltaWei.sign,
    token,
  )
  let accountUpdate1 = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate1, event)

  let balanceUpdate2 = new BalanceUpdate(
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign,
    event.params.updateTwo.deltaWei.value,
    event.params.updateTwo.deltaWei.sign,
    token,
  )
  let accountUpdate2 = handleDolomiteMarginBalanceUpdateForAccount(balanceUpdate2, event)

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let transferID = getIDForEvent(event)
  let transfer = Transfer.load(transferID)
  if (transfer === null) {
    transfer = new Transfer(transferID)
    transfer.isTransferForMarginPosition = false
    transfer.serialId = dolomiteMargin.actionCount
  }

  transfer.transaction = transaction.id
  transfer.logIndex = event.logIndex

  let fromMarginAccount = event.params.updateOne.deltaWei.sign ? accountUpdate2.marginAccount : accountUpdate1.marginAccount
  let fromDeltaPar = event.params.updateOne.deltaWei.sign ? accountUpdate2.deltaPar : accountUpdate1.deltaPar
  let toMarginAccount = event.params.updateOne.deltaWei.sign ? accountUpdate1.marginAccount : accountUpdate2.marginAccount
  let toDeltaPar = event.params.updateOne.deltaWei.sign ? accountUpdate1.deltaPar : accountUpdate2.deltaPar

  transfer.fromEffectiveUser = getEffectiveUserForAddressString(fromMarginAccount.user).id
  transfer.fromMarginAccount = fromMarginAccount.id
  transfer.toEffectiveUser = getEffectiveUserForAddressString(toMarginAccount.user).id
  transfer.toMarginAccount = toMarginAccount.id
  transfer.isSelfTransfer = transfer.fromMarginAccount == transfer.toMarginAccount
  transfer.walletsConcatenated = `${accountUpdate1.marginAccount.user}_${accountUpdate2.marginAccount.user}`
  transfer.effectiveWalletsConcatenated = `${transfer.fromEffectiveUser}_${transfer.toEffectiveUser}`
  transfer.effectiveUsers = [transfer.fromEffectiveUser, transfer.toEffectiveUser]

  transfer.token = token.id

  let marketIndex = InterestIndex.load(token.id) as InterestIndex
  transfer.interestIndex = getOrCreateInterestIndexSnapshotAndReturnId(marketIndex)

  let amountDeltaWei = new ValueStruct(event.params.updateOne.deltaWei)
  let priceUSD = getTokenOraclePriceUSD(token, event, ProtocolType.Core)
  transfer.amountDeltaWei = convertStructToDecimalAppliedValue(amountDeltaWei.abs(), token.decimals)
  transfer.fromAmountDeltaPar = fromDeltaPar
  transfer.toAmountDeltaPar = toDeltaPar
  transfer.amountUSDDeltaWei = transfer.amountDeltaWei.times(priceUSD)
    .truncate(USD_PRECISION)

  accountUpdate1.marginAccount.save()
  accountUpdate2.marginAccount.save()
  transfer.save()

  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    token,
    new ValueStruct(event.params.updateOne.deltaWei),
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )
  changeProtocolBalance(
    event,
    token,
    new ValueStruct(event.params.updateTwo.deltaWei),
    marketIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  updateMarginPositionForTransfer(
    accountUpdate1.marginAccount,
    accountUpdate2.marginAccount,
    balanceUpdate1,
    balanceUpdate2,
    transfer,
    event,
    token,
    priceUSD,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleBuy(event: BuyEvent): void {
  log.info(
    'Handling BUY for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let inputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.takerMarket.toString())!.token) as Token
  let outputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.makerMarket.toString())!.token) as Token

  let takerInputUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    event.params.takerUpdate.deltaWei.value,
    event.params.takerUpdate.deltaWei.sign,
    inputToken,
  )
  let takerOutputUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    event.params.makerUpdate.deltaWei.value,
    event.params.makerUpdate.deltaWei.sign,
    outputToken,
  )

  _handleTraderInternal(
    event,
    event.params.exchangeWrapper,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputUpdate,
    null,
    null,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleSell(event: SellEvent): void {
  log.info(
    'Handling SELL for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let inputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.takerMarket.toString())!.token) as Token
  let outputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.makerMarket.toString())!.token) as Token

  let takerInputUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    event.params.takerUpdate.deltaWei.value,
    event.params.takerUpdate.deltaWei.sign,
    inputToken,
  )
  let takerOutputUpdate = new BalanceUpdate(
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    event.params.makerUpdate.deltaWei.value,
    event.params.makerUpdate.deltaWei.sign,
    outputToken,
  )

  _handleTraderInternal(
    event,
    event.params.exchangeWrapper,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputUpdate,
    null,
    null,
  )
}

// noinspection JSUnusedGlobalSymbols
export function handleTrade(event: TradeEvent): void {
  let inputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.inputMarket.toString())!.token) as Token
  let outputToken = Token.load(TokenMarketIdReverseLookup.load(event.params.outputMarket.toString())!.token) as Token

  let takerInputUpdate = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign,
    event.params.takerInputUpdate.deltaWei.value,
    event.params.takerInputUpdate.deltaWei.sign,
    inputToken,
  )
  let takerOutputTUpdate = new BalanceUpdate(
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign,
    event.params.takerOutputUpdate.deltaWei.value,
    event.params.takerOutputUpdate.deltaWei.sign,
    outputToken,
  )

  let makerInputUpdate = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign,
    event.params.makerInputUpdate.deltaWei.value,
    event.params.makerInputUpdate.deltaWei.sign,
    inputToken,
  )
  let makerOutputUpdate = new BalanceUpdate(
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign,
    event.params.makerOutputUpdate.deltaWei.value,
    event.params.makerOutputUpdate.deltaWei.sign,
    outputToken,
  )

  _handleTraderInternal(
    event,
    event.params.autoTrader,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputTUpdate,
    makerInputUpdate,
    makerOutputUpdate,
  )
}

function _handleTraderInternal(
  event: ethereum.Event,
  traderAddress: Address,
  inputToken: Token,
  outputToken: Token,
  takerInputBalanceUpdate: BalanceUpdate,
  takerOutputBalanceUpdate: BalanceUpdate,
  makerInputBalanceUpdate: BalanceUpdate | null,
  makerOutputBalanceUpdate: BalanceUpdate | null,
): void {
  log.info(
    'Handling trade for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let takerInputAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    takerInputBalanceUpdate,
    event,
  )
  let takerOutputAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    takerOutputBalanceUpdate,
    event,
  )

  let makerInputAccountUpdate: MarginAccountWithValueParChange | null = null
  let makerOutputAccountUpdate: MarginAccountWithValueParChange | null = null
  if (makerInputBalanceUpdate !== null && makerOutputBalanceUpdate !== null) {
    makerInputAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
      makerInputBalanceUpdate,
      event,
    )
    makerOutputAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
      makerOutputBalanceUpdate,
      event,
    )
  }

  let takerInputDeltaWei = takerInputBalanceUpdate.deltaWei
  let takerOutputDeltaWei = takerOutputBalanceUpdate.deltaWei
  let makerInputDeltaWei = makerInputBalanceUpdate ? makerInputBalanceUpdate.deltaWei : null
  let makerOutputDeltaWei = makerOutputBalanceUpdate ? makerOutputBalanceUpdate.deltaWei : null
  let isVirtualTransfer = makerInputAccountUpdate !== null
  let serialId = dolomiteMargin.actionCount
  let intermediateTrade: IntermediateTrade | null = null
  if (inputToken.symbol.startsWith('pol-') || outputToken.symbol.startsWith('pol-')) {
    isVirtualTransfer = true // POL tokens are always virtual
    let transactionHash = event.transaction.hash.toHexString()
    intermediateTrade = IntermediateTrade.load(`${transactionHash}-${serialId.minus(ONE_BI).toString()}`)
    if (intermediateTrade === null) {
      // Save and return; the intermediate trade was not created yet.
      intermediateTrade = new IntermediateTrade(`${transactionHash}-${serialId.toString()}`)

      intermediateTrade.serialId = serialId
      intermediateTrade.traderAddress = traderAddress

      intermediateTrade.takerEffectiveUser = getEffectiveUserForAddressString(takerOutputAccountUpdate.marginAccount.user).id
      intermediateTrade.takerMarginAccount = takerOutputAccountUpdate.marginAccount.id
      intermediateTrade.makerEffectiveUser = makerOutputAccountUpdate ? getEffectiveUserForAddressString(
        makerOutputAccountUpdate.marginAccount.user).id : null
      intermediateTrade.makerMarginAccount = makerOutputAccountUpdate ? makerOutputAccountUpdate.marginAccount.id : null
      intermediateTrade.walletsConcatenated = makerOutputAccountUpdate ? `${takerOutputAccountUpdate.marginAccount.user}_${makerOutputAccountUpdate.marginAccount.user}` : takerOutputAccountUpdate.marginAccount.user
      intermediateTrade.effectiveWalletsConcatenated = makerOutputAccountUpdate ? `${intermediateTrade.takerEffectiveUser}_${intermediateTrade.makerEffectiveUser!}` : intermediateTrade.takerEffectiveUser
      intermediateTrade.effectiveUsers = [intermediateTrade.takerEffectiveUser, intermediateTrade.makerEffectiveUser!]

      intermediateTrade.takerInputDeltaPar = takerInputAccountUpdate.deltaPar
      intermediateTrade.takerOutputDeltaPar = takerOutputAccountUpdate.deltaPar
      intermediateTrade.makerInputDeltaPar = makerInputAccountUpdate !== null ? makerInputAccountUpdate.deltaPar : null
      intermediateTrade.makerOutputDeltaPar = makerOutputAccountUpdate !== null ? makerOutputAccountUpdate.deltaPar : null

      intermediateTrade.save()
    } else {
      takerInputDeltaWei = intermediateTrade.takerInputDeltaWei.gt(ZERO_BD)
        ? intermediateTrade.takerInputDeltaWei : takerInputBalanceUpdate.deltaWei
      takerOutputDeltaWei = intermediateTrade.takerOutputDeltaWei.gt(ZERO_BD)
        ? intermediateTrade.takerOutputDeltaWei : takerOutputBalanceUpdate.deltaWei
      makerInputDeltaWei = intermediateTrade.makerInputDeltaWei !== null && intermediateTrade.makerInputDeltaWei.gt(ZERO_BD)
        ? intermediateTrade.makerInputDeltaWei
        : makerInputBalanceUpdate && makerInputBalanceUpdate.deltaWei.gt(ZERO_BD)
          ? makerInputBalanceUpdate.deltaWei : null
      makerOutputDeltaWei = intermediateTrade.makerOutputDeltaWei !== null && intermediateTrade.makerOutputDeltaWei.gt(ZERO_BD)
        ? intermediateTrade.makerOutputDeltaWei
        : makerOutputBalanceUpdate && makerOutputBalanceUpdate.deltaWei.gt(ZERO_BD)
          ? makerOutputBalanceUpdate.deltaWei : null
    }
  }

  let tradeID = getIDForEvent(event)
  let trade = Trade.load(tradeID)
  if (trade === null) {
    trade = new Trade(tradeID)
    trade.serialId = serialId
    trade.traderAddress = traderAddress
  }

  trade.transaction = transaction.id
  trade.timestamp = transaction.timestamp
  trade.logIndex = event.logIndex

  trade.takerEffectiveUser = getEffectiveUserForAddressString(takerOutputAccountUpdate.marginAccount.user).id
  trade.takerMarginAccount = takerOutputAccountUpdate.marginAccount.id
  trade.makerEffectiveUser = intermediateTrade !== null && intermediateTrade.makerEffectiveUser !== null
    ? intermediateTrade.makerEffectiveUser
    : makerOutputAccountUpdate ? getEffectiveUserForAddressString(makerOutputAccountUpdate.marginAccount.user).id : null
  trade.makerMarginAccount = intermediateTrade !== null && intermediateTrade.makerMarginAccount !== null
    ? intermediateTrade.makerMarginAccount
    : makerOutputAccountUpdate ? makerOutputAccountUpdate.marginAccount.id : null
  trade.walletsConcatenated = makerOutputAccountUpdate ? `${takerOutputAccountUpdate.marginAccount.user}_${makerOutputAccountUpdate.marginAccount.user}` : takerOutputAccountUpdate.marginAccount.user
  trade.effectiveWalletsConcatenated = makerOutputAccountUpdate ? `${trade.takerEffectiveUser}_${trade.makerEffectiveUser!}` : trade.takerEffectiveUser
  trade.effectiveUsers = [trade.takerEffectiveUser, trade.makerEffectiveUser!]

  trade.takerToken = inputToken.id
  trade.makerToken = outputToken.id

  let inputIndex = InterestIndex.load(inputToken.id) as InterestIndex
  let outputIndex = InterestIndex.load(outputToken.id) as InterestIndex

  trade.takerInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(inputIndex)
  trade.makerInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(outputIndex)

  let takerToken = takerInputDeltaWei.lt(ZERO_BD) ? inputToken : outputToken
  let makerToken = takerInputDeltaWei.lt(ZERO_BD) ? outputToken : inputToken
  trade.takerTokenDeltaWei = takerInputDeltaWei.lt(ZERO_BD)
    ? absBD(takerInputDeltaWei)
    : absBD(takerOutputDeltaWei)

  trade.makerTokenDeltaWei = takerInputDeltaWei.lt(ZERO_BD)
    ? absBD(takerOutputDeltaWei)
    : absBD(takerInputDeltaWei)

  trade.amountUSD = trade.takerTokenDeltaWei
    .times(getTokenOraclePriceUSD(takerToken, event, ProtocolType.Core))
    .truncate(USD_PRECISION)
  trade.takerAmountUSD = trade.amountUSD
  trade.makerAmountUSD = trade.makerTokenDeltaWei
    .times(getTokenOraclePriceUSD(makerToken, event, ProtocolType.Core))
    .truncate(USD_PRECISION)

  if (trade.traderAddress.equals(Address.fromString(EXPIRY_ADDRESS))) {
    trade.liquidationType = TradeLiquidationType.EXPIRATION
  }

  trade.takerInputTokenDeltaPar = takerInputAccountUpdate.deltaPar.lt(ZERO_BD) ? takerInputAccountUpdate.deltaPar : takerOutputAccountUpdate.deltaPar
  trade.takerOutputTokenDeltaPar = takerOutputAccountUpdate.deltaPar.gt(ZERO_BD) ? takerOutputAccountUpdate.deltaPar : takerInputAccountUpdate.deltaPar
  trade.makerInputTokenDeltaPar = makerInputAccountUpdate !== null && makerOutputAccountUpdate !== null
    ? makerInputAccountUpdate.deltaPar.lt(ZERO_BD) ? makerInputAccountUpdate.deltaPar : makerOutputAccountUpdate.deltaPar
    : null
  trade.makerOutputTokenDeltaPar = makerOutputAccountUpdate !== null && makerInputAccountUpdate !== null
    ? makerOutputAccountUpdate.deltaPar.gt(ZERO_BD) ? makerOutputAccountUpdate.deltaPar : makerInputAccountUpdate.deltaPar
    : null

  updateAndSaveVolumeForTrade(trade, dolomiteMargin, makerToken, takerToken)

  trade.save()
  dolomiteMargin.save()

  saveMostRecentTrade(trade)

  changeProtocolBalanceApplied(
    event,
    inputToken,
    takerInputDeltaWei,
    inputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  changeProtocolBalanceApplied(
    event,
    outputToken,
    takerOutputDeltaWei,
    outputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  if (makerInputDeltaWei && makerOutputDeltaWei) {
    changeProtocolBalanceApplied(
      event,
      inputToken,
      makerInputDeltaWei,
      inputIndex,
      isVirtualTransfer,
      ProtocolType.Core,
      dolomiteMargin,
    )
    changeProtocolBalanceApplied(
      event,
      outputToken,
      makerOutputDeltaWei,
      outputIndex,
      isVirtualTransfer,
      ProtocolType.Core,
      dolomiteMargin,
    )
  }

  // if the trade is against the expiry contract, we need to change the margin position
  if (trade.traderAddress.equals(Address.fromString(EXPIRY_ADDRESS))) {
    if (
      makerOutputAccountUpdate === null ||
      makerInputDeltaWei === null ||
      makerOutputDeltaWei === null
    ) {
      log.critical('makerOutputAccountUpdate cannot be null for expiration trades!', [])
      return
    }
    log.info('Handling expiration for margin account {}', [makerOutputAccountUpdate.marginAccount.id])
    // the maker is
    let marginPosition = getOrCreateMarginPosition(event, makerOutputAccountUpdate.marginAccount)

    let heldToken = marginPosition.heldToken == outputToken.id ? outputToken : inputToken
    let owedToken = marginPosition.owedToken == outputToken.id ? outputToken : inputToken

    let heldPrice = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
    let owedPrice = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

    let expirationTimestamp = marginPosition.expirationTimestamp
    if (expirationTimestamp === null) {
      log.error('Attempted to expire a non-expirable position', [])
      return
    }

    let liquidationSpread = getLiquidationSpreadForPair(heldToken, owedToken, dolomiteMargin)
    let expiryAge = event.block.timestamp.minus(expirationTimestamp)
    let expiryRampTime = dolomiteMargin.expiryRampTime
    if (expiryAge.lt(expiryRampTime)) {
      liquidationSpread = liquidationSpread.times(new BigDecimal(expiryAge))
        .div(new BigDecimal(expiryRampTime))
        .truncate(18)
    }

    let owedPriceAdj = owedPrice.times(liquidationSpread)
      .truncate(36)

    let heldNewPar = marginPosition.heldToken == outputToken.id && makerOutputBalanceUpdate
      ? makerOutputBalanceUpdate.valuePar
      : makerInputBalanceUpdate!.valuePar
    let owedNewPar = marginPosition.owedToken == outputToken.id && makerOutputBalanceUpdate
      ? makerOutputBalanceUpdate.valuePar
      : makerInputBalanceUpdate!.valuePar

    let borrowedTokenAmountDeltaWei = marginPosition.owedToken == outputToken.id
      ? makerOutputDeltaWei : makerInputDeltaWei

    handleLiquidateMarginPosition(
      marginPosition,
      event,
      heldPrice,
      owedPriceAdj,
      heldToken,
      owedToken,
      marginPosition.heldToken == outputToken.id ? outputIndex : inputIndex,
      marginPosition.owedToken == outputToken.id ? outputIndex : inputIndex,
      heldNewPar,
      owedNewPar,
      absBD(borrowedTokenAmountDeltaWei),
      MarginPositionStatus.Expired,
    )
  }

  if (makerOutputAccountUpdate !== null) {
    let makerUser = User.load(makerOutputAccountUpdate.marginAccount.user) as User
    makerUser.totalTradeVolumeUSD = makerUser.totalTradeVolumeUSD.plus(trade.makerAmountUSD)
    makerUser.totalTradeCount = makerUser.totalTradeCount.plus(ONE_BI)
    makerUser.save()
    if (makerUser.effectiveUser != makerUser.id) {
      let effectiveMakerUser = User.load(makerUser.effectiveUser) as User
      effectiveMakerUser.totalTradeVolumeUSD = effectiveMakerUser.totalTradeVolumeUSD.plus(trade.makerAmountUSD)
      effectiveMakerUser.totalTradeCount = effectiveMakerUser.totalTradeCount.plus(ONE_BI)
      effectiveMakerUser.save()
    }
  }

  let takerUser = User.load(takerOutputAccountUpdate.marginAccount.user) as User
  takerUser.totalTradeVolumeUSD = takerUser.totalTradeVolumeUSD.plus(trade.takerAmountUSD)
  takerUser.totalTradeCount = takerUser.totalTradeCount.plus(ONE_BI)
  takerUser.save()
  if (takerUser.effectiveUser != takerUser.id) {
    let effectiveTakerUser = User.load(takerUser.effectiveUser) as User
    effectiveTakerUser.totalTradeVolumeUSD = effectiveTakerUser.totalTradeVolumeUSD.plus(trade.takerAmountUSD)
    effectiveTakerUser.totalTradeCount = effectiveTakerUser.totalTradeCount.plus(ONE_BI)
    effectiveTakerUser.save()
  }
}

// noinspection JSUnusedGlobalSymbols
export function handleLiquidate(event: LiquidationEvent): void {
  log.info(
    'Handling liquidate for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let heldToken = Token.load(TokenMarketIdReverseLookup.load(event.params.heldMarket.toString())!.token) as Token
  let owedToken = Token.load(TokenMarketIdReverseLookup.load(event.params.owedMarket.toString())!.token) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign,
    event.params.liquidHeldUpdate.deltaWei.value,
    event.params.liquidHeldUpdate.deltaWei.sign,
    heldToken,
  )
  let liquidHeldAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateOne,
    event,
  )

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign,
    event.params.liquidOwedUpdate.deltaWei.value,
    event.params.liquidOwedUpdate.deltaWei.sign,
    owedToken,
  )
  let liquidOwedAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateTwo,
    event,
  )

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    event.params.solidHeldUpdate.deltaWei.value,
    event.params.solidHeldUpdate.deltaWei.sign,
    heldToken,
  )
  let solidHeldAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateThree,
    event,
  )

  let balanceUpdateFour = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    event.params.solidOwedUpdate.deltaWei.value,
    event.params.solidOwedUpdate.deltaWei.sign,
    owedToken,
  )
  let solidOwedAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateFour,
    event,
  )

  let transaction = getOrCreateTransaction(event)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let liquidationID = getIDForEvent(event)
  let liquidation = Liquidation.load(liquidationID)
  if (liquidation === null) {
    liquidation = new Liquidation(liquidationID)
    liquidation.serialId = dolomiteMargin.actionCount
  }

  liquidation.transaction = transaction.id
  liquidation.logIndex = event.logIndex

  liquidation.liquidEffectiveUser = getEffectiveUserForAddressString(liquidOwedAccountUpdate.marginAccount.user).id
  liquidation.liquidMarginAccount = liquidOwedAccountUpdate.marginAccount.id
  liquidation.solidEffectiveUser = getEffectiveUserForAddressString(solidOwedAccountUpdate.marginAccount.user).id
  liquidation.solidMarginAccount = solidOwedAccountUpdate.marginAccount.id
  liquidation.effectiveUsers = [liquidation.liquidEffectiveUser, liquidation.solidEffectiveUser]

  liquidation.heldToken = heldToken.id
  liquidation.borrowedToken = owedToken.id

  let heldIndex = InterestIndex.load(heldToken.id) as InterestIndex
  let owedIndex = InterestIndex.load(owedToken.id) as InterestIndex

  liquidation.heldInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(heldIndex)
  liquidation.borrowedInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(owedIndex)

  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  liquidation.heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    solidHeldDeltaWeiStruct.abs(),
    heldToken.decimals,
  )

  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  liquidation.borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    solidOwedDeltaWeiStruct.abs(),
    owedToken.decimals,
  )

  let liquidHeldDeltaWeiStruct = new ValueStruct(event.params.liquidHeldUpdate.deltaWei)
  let liquidHeldNewParStruct = new ValueStruct(event.params.liquidHeldUpdate.newPar)

  let liquidOwedDeltaWeiStruct = new ValueStruct(event.params.liquidOwedUpdate.deltaWei)
  let liquidOwedNewParStruct = new ValueStruct(event.params.liquidOwedUpdate.newPar)

  let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
  let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

  let liquidationSpread = getLiquidationSpreadForPair(heldToken, owedToken, dolomiteMargin)

  let owedPriceAdj = owedPriceUSD.times(liquidationSpread)
    .truncate(36)

  liquidation.heldTokenLiquidationRewardWei = roundHalfUp(
    liquidation.borrowedTokenAmountDeltaWei.times(owedPriceAdj)
      .div(heldPriceUSD),
    heldToken.decimals,
  )

  liquidation.borrowedTokenAmountUSD = liquidation.borrowedTokenAmountDeltaWei.times(owedPriceUSD)
    .truncate(USD_PRECISION)

  liquidation.heldTokenAmountUSD = liquidation.heldTokenAmountDeltaWei.times(heldPriceUSD)
    .truncate(USD_PRECISION)

  liquidation.heldTokenLiquidationRewardUSD =
    liquidation.heldTokenLiquidationRewardWei.times(heldPriceUSD)
      .truncate(USD_PRECISION)

  liquidation.liquidBorrowedTokenAmountDeltaPar = liquidOwedAccountUpdate.deltaPar
  liquidation.liquidHeldTokenAmountDeltaPar = liquidHeldAccountUpdate.deltaPar
  liquidation.solidBorrowedTokenAmountDeltaPar = solidOwedAccountUpdate.deltaPar
  liquidation.solidHeldTokenAmountDeltaPar = solidHeldAccountUpdate.deltaPar

  dolomiteMargin.liquidationCount = dolomiteMargin.liquidationCount.plus(ONE_BI)
  dolomiteMargin.totalLiquidationVolumeUSD =
    dolomiteMargin.totalLiquidationVolumeUSD.plus(liquidation.borrowedTokenAmountUSD)
  dolomiteMargin.save()

  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    heldToken,
    solidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  changeProtocolBalance(
    event,
    owedToken,
    solidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  changeProtocolBalance(
    event,
    heldToken,
    liquidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )
  changeProtocolBalance(
    event,
    owedToken,
    liquidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  liquidOwedAccountUpdate.marginAccount.save()
  solidOwedAccountUpdate.marginAccount.save()
  liquidation.save()

  if (canBeMarginPosition(liquidOwedAccountUpdate.marginAccount)) {
    let marginPosition = getOrCreateMarginPosition(event, liquidOwedAccountUpdate.marginAccount)
    handleLiquidateMarginPosition(
      marginPosition,
      event,
      heldPriceUSD,
      owedPriceAdj,
      heldToken,
      owedToken,
      heldIndex,
      owedIndex,
      convertStructToDecimalAppliedValue(liquidHeldNewParStruct, heldToken.decimals),
      convertStructToDecimalAppliedValue(liquidOwedNewParStruct, owedToken.decimals),
      liquidation.borrowedTokenAmountDeltaWei,
      MarginPositionStatus.Liquidated,
    )
  }

  updateBorrowPositionForLiquidation(liquidOwedAccountUpdate.marginAccount, event)

  let liquidUser = User.load(liquidOwedAccountUpdate.marginAccount.user) as User
  // heldTokenAmountUSD in this case is the amount of held collateral seized + the liquidation reward
  liquidUser.totalCollateralLiquidatedUSD = liquidUser.totalCollateralLiquidatedUSD.plus(liquidation.heldTokenAmountUSD)
  liquidUser.totalLiquidationCount = liquidUser.totalLiquidationCount.plus(ONE_BI)
  liquidUser.save()
  if (liquidUser.effectiveUser != liquidUser.id) {
    let effectiveLiquidUser = User.load(liquidUser.effectiveUser) as User
    effectiveLiquidUser.totalCollateralLiquidatedUSD =
      effectiveLiquidUser.totalCollateralLiquidatedUSD.plus(liquidation.heldTokenAmountUSD)
    effectiveLiquidUser.totalLiquidationCount = effectiveLiquidUser.totalLiquidationCount.plus(ONE_BI)
    effectiveLiquidUser.save()
  }
}

// noinspection JSUnusedGlobalSymbols
export function handleVaporize(event: VaporizationEvent): void {
  log.info(
    'Handling vaporize for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  let heldToken = Token.load(TokenMarketIdReverseLookup.load(event.params.heldMarket.toString())!.token) as Token
  let owedToken = Token.load(TokenMarketIdReverseLookup.load(event.params.owedMarket.toString())!.token) as Token

  let balanceUpdateOne = new BalanceUpdate(
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign,
    event.params.vaporOwedUpdate.deltaWei.value,
    event.params.vaporOwedUpdate.deltaWei.sign,
    owedToken,
  )
  let vaporOwedAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateOne,
    event,
  )

  let balanceUpdateTwo = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    event.params.solidHeldUpdate.deltaWei.value,
    event.params.solidHeldUpdate.deltaWei.sign,
    heldToken,
  )
  let solidHeldAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateTwo,
    event,
  )

  let balanceUpdateThree = new BalanceUpdate(
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    event.params.solidOwedUpdate.deltaWei.value,
    event.params.solidOwedUpdate.deltaWei.sign,
    owedToken,
  )
  let solidOwedAccountUpdate = handleDolomiteMarginBalanceUpdateForAccount(
    balanceUpdateThree,
    event,
  )

  let transaction = getOrCreateTransaction(event)

  let vaporOwedNewParStruct = new ValueStruct(event.params.vaporOwedUpdate.newPar)
  let vaporOwedDeltaWeiStruct = new ValueStruct(event.params.vaporOwedUpdate.deltaWei)

  let solidHeldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)

  let solidOwedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)

  let dolomiteMargin = getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)

  let vaporizationID = getIDForEvent(event)
  let vaporization = Vaporization.load(vaporizationID)
  if (vaporization === null) {
    vaporization = new Vaporization(vaporizationID)
    vaporization.serialId = dolomiteMargin.actionCount
  }

  vaporization.transaction = transaction.id
  vaporization.logIndex = event.logIndex

  vaporization.vaporEffectiveUser = getEffectiveUserForAddressString(vaporOwedAccountUpdate.marginAccount.user).id
  vaporization.vaporMarginAccount = vaporOwedAccountUpdate.marginAccount.id
  vaporization.solidEffectiveUser = getEffectiveUserForAddressString(solidOwedAccountUpdate.marginAccount.user).id
  vaporization.solidMarginAccount = solidOwedAccountUpdate.marginAccount.id
  vaporization.effectiveUsers = [vaporization.vaporEffectiveUser, vaporization.solidEffectiveUser]

  vaporization.heldToken = heldToken.id
  vaporization.borrowedToken = owedToken.id

  let heldIndex = InterestIndex.load(heldToken.id) as InterestIndex
  let owedIndex = InterestIndex.load(owedToken.id) as InterestIndex

  vaporization.heldInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(heldIndex)
  vaporization.borrowedInterestIndex = getOrCreateInterestIndexSnapshotAndReturnId(owedIndex)

  let borrowedDeltaWeiStruct = new ValueStruct(event.params.solidOwedUpdate.deltaWei)
  vaporization.borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    borrowedDeltaWeiStruct.abs(),
    owedToken.decimals,
  )

  let heldDeltaWeiStruct = new ValueStruct(event.params.solidHeldUpdate.deltaWei)
  vaporization.heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    heldDeltaWeiStruct.abs(),
    heldToken.decimals,
  )

  let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

  let vaporOwedDeltaWeiBD = convertStructToDecimalAppliedValue(vaporOwedDeltaWeiStruct, owedToken.decimals)
  vaporization.amountUSDVaporized = vaporOwedDeltaWeiBD.times(owedPriceUSD)
    .truncate(USD_PRECISION)

  vaporization.vaporBorrowedTokenAmountDeltaPar = vaporOwedAccountUpdate.deltaPar
  vaporization.solidHeldTokenAmountDeltaPar = solidHeldAccountUpdate.deltaPar
  vaporization.solidBorrowedTokenAmountDeltaPar = solidOwedAccountUpdate.deltaPar

  dolomiteMargin.vaporizationCount = dolomiteMargin.vaporizationCount.plus(ONE_BI)
  dolomiteMargin.totalVaporizationVolumeUSD = dolomiteMargin.totalVaporizationVolumeUSD.plus(vaporization.amountUSDVaporized)
  dolomiteMargin.save()

  let isVirtualTransfer = true
  changeProtocolBalance(
    event,
    heldToken,
    solidHeldDeltaWeiStruct,
    heldIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  changeProtocolBalance(
    event,
    owedToken,
    solidOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )
  changeProtocolBalance(
    event,
    owedToken,
    vaporOwedDeltaWeiStruct,
    owedIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin,
  )

  if (canBeMarginPosition(vaporOwedAccountUpdate.marginAccount)) {
    let marginPosition = getOrCreateMarginPosition(event, vaporOwedAccountUpdate.marginAccount)
    if (marginPosition.status == MarginPositionStatus.Liquidated) {
      // vaporized accounts must be liquidated before being vaporized
      // when an account is vaporized, the vaporHeldAmount is zero, so it's not updated
      marginPosition.owedAmountPar = convertStructToDecimalAppliedValue(vaporOwedNewParStruct, owedToken.decimals)
      marginPosition.save()
    }
  }

  vaporOwedAccountUpdate.marginAccount.save()
  solidOwedAccountUpdate.marginAccount.save()
  vaporization.save()
}

// noinspection JSUnusedGlobalSymbols
export function handleCall(event: CallEvent): void {
  log.info(
    'Handling call for hash and index: {}-{}',
    [event.transaction.hash.toHexString(), event.logIndex.toString()],
  )

  // This function saves the actionCount, so it's not necessary to use the return value
  getOrCreateDolomiteMarginForCall(event, true, ProtocolType.Core)
}

/**
 * Handles liquidations via the liquidation action and liquidation via expiration
 */
function handleLiquidateMarginPosition(
  marginPosition: MarginPosition,
  event: ethereum.Event,
  heldPrice: BigDecimal,
  owedPriceAdj: BigDecimal,
  heldToken: Token,
  owedToken: Token,
  heldIndex: InterestIndex,
  owedIndex: InterestIndex,
  heldNewPar: BigDecimal,
  owedNewPar: BigDecimal,
  borrowedTokenAmountDeltaWei: BigDecimal,
  status: string,
): void {
  if (
    marginPosition.isInitialized && (
      marginPosition.status == MarginPositionStatus.Open ||
      marginPosition.status == MarginPositionStatus.Liquidated ||
      marginPosition.status == MarginPositionStatus.Expired
    )
  ) {
    log.info('Setting position {} to {}', [marginPosition.id, status])
    marginPosition.status = status
    if (marginPosition.closeTimestamp === null) {
      marginPosition.closeTimestamp = event.block.timestamp
      marginPosition.closeTransaction = event.transaction.hash.toHexString()
    }

    let heldTokenLiquidationRewardWei = roundHalfUp(
      borrowedTokenAmountDeltaWei.times(owedPriceAdj)
        .div(heldPrice),
      heldToken.decimals,
    )

    let heldTokenLiquidationRewardUSD = heldTokenLiquidationRewardWei.times(heldPrice)
      .truncate(USD_PRECISION)

    marginPosition.heldAmountPar = heldNewPar
    marginPosition.owedAmountPar = owedNewPar

    if (marginPosition.closeHeldAmountUSD === null && marginPosition.closeOwedAmountUSD === null) {
      let heldPriceUSD = getTokenOraclePriceUSD(heldToken, event, ProtocolType.Core)
      let owedPriceUSD = getTokenOraclePriceUSD(owedToken, event, ProtocolType.Core)

      let closeHeldAmountWei = parToWei(marginPosition.initialHeldAmountPar, heldIndex, heldToken.decimals)
      let closeOwedAmountWei = parToWei(marginPosition.initialOwedAmountPar.neg(), owedIndex, owedToken.decimals)
        .neg()

      marginPosition.closeHeldPrice = heldPriceUSD.div(owedPriceUSD)
        .truncate(USD_PRECISION)
      marginPosition.closeHeldPriceUSD = heldPriceUSD.truncate(USD_PRECISION)
      marginPosition.closeHeldAmountWei = closeHeldAmountWei
      marginPosition.closeHeldAmountUSD = closeHeldAmountWei.times(heldPriceUSD)
        .truncate(USD_PRECISION)

      let closeHeldAmountSeized = marginPosition.closeHeldAmountSeized
      let closeHeldAmountSeizedUSD = marginPosition.closeHeldAmountSeizedUSD
      if (closeHeldAmountSeized !== null && closeHeldAmountSeizedUSD !== null) {
        marginPosition.closeHeldAmountSeized = closeHeldAmountSeized.plus(heldTokenLiquidationRewardWei)
        marginPosition.closeHeldAmountSeizedUSD = closeHeldAmountSeizedUSD.plus(heldTokenLiquidationRewardUSD)
      } else {
        marginPosition.closeHeldAmountSeized = heldTokenLiquidationRewardWei
        marginPosition.closeHeldAmountSeizedUSD = heldTokenLiquidationRewardUSD
      }

      marginPosition.closeOwedPrice = owedPriceUSD.div(heldPriceUSD)
        .truncate(USD_PRECISION)
      marginPosition.closeOwedPriceUSD = owedPriceUSD.truncate(USD_PRECISION)
      marginPosition.closeOwedAmountWei = closeOwedAmountWei
      marginPosition.closeOwedAmountUSD = closeOwedAmountWei.times(owedPriceUSD)
        .truncate(USD_PRECISION)
    }

    marginPosition.save()
  }
}
