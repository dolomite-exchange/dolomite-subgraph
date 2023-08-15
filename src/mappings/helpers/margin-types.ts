import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  ethereum
} from '@graphprotocol/graph-ts'
import {
  MarginPosition,
  Token
} from '../../types/schema'

import { convertTokenToDecimal } from './token-helpers'

export class ProtocolType {
  // eslint-disable-next-line
  static Core: string = 'CORE'
  // eslint-disable-next-line
  static Admin: string = 'ADMIN'
  // eslint-disable-next-line
  static Expiry: string = 'EXPIRY'
  // eslint-disable-next-line
  static Amm: string = 'AMM'
  // eslint-disable-next-line
  static Position: string = 'POSITION'
  // eslint-disable-next-line
  static Zap: string = 'ZAP'
}

export class PositionChangeEvent {

  accountOwner: Address
  accountNumber: BigInt
  inputToken: Token
  outputToken: Token
  depositToken: Token
  inputWei: BigDecimal
  outputWei: BigDecimal
  depositWei: BigDecimal
  isOpen: boolean
  block: BigInt
  timestamp: BigInt
  hash: Bytes

  constructor(
    accountOwner: Address,
    accountNumber: BigInt,
    inputToken: Token,
    outputToken: Token,
    depositToken: Token,
    inputWei: BigInt,
    outputWei: BigInt,
    depositWei: BigInt,
    isOpen: boolean,
    block: BigInt,
    timestamp: BigInt,
    hash: Bytes
  ) {
    this.accountOwner = accountOwner
    this.accountNumber = accountNumber
    this.inputToken = inputToken
    this.outputToken = outputToken
    this.depositToken = depositToken
    this.inputWei = convertTokenToDecimal(inputWei, inputToken.decimals)
    this.outputWei = convertTokenToDecimal(outputWei, outputToken.decimals)
    this.depositWei = convertTokenToDecimal(depositWei, depositToken.decimals)
    this.isOpen = isOpen
    this.block = block
    this.timestamp = timestamp
    this.hash = hash
  }

}

export class BalanceUpdate {

  accountOwner: Address
  accountNumber: BigInt
  token: Token
  valuePar: BigDecimal
  deltaWei: BigDecimal

  constructor(
    accountOwner: Address,
    accountNumber: BigInt,
    valuePar: BigInt,
    valueParSign: boolean,
    deltaWei: BigInt,
    deltaWeiSign: boolean,
    token: Token
  ) {
    this.accountOwner = accountOwner
    this.accountNumber = accountNumber
    this.token = token
    if (valueParSign) {
      this.valuePar = convertTokenToDecimal(valuePar, token.decimals)
    } else {
      this.valuePar = convertTokenToDecimal(valuePar.neg(), token.decimals)
    }
    if (deltaWeiSign) {
      this.deltaWei = convertTokenToDecimal(deltaWei, token.decimals)
    } else {
      this.deltaWei = convertTokenToDecimal(deltaWei.neg(), token.decimals)
    }
  }

  get marginAccount(): string {
    return `${this.accountOwner.toHexString()}-${this.accountNumber.toString()}`
  }

}

export class ValueStruct {

  private tuple: Array<ethereum.Value>

  constructor(tuple: Array<ethereum.Value>) {
    this.tuple = tuple
  }

  get sign(): boolean {
    return this.tuple[0].toBoolean()
  }

  get value(): BigInt {
    return this.tuple[1].toBigInt()
  }

  static fromFields(sign: boolean, value: BigInt): ValueStruct {
    let values: ethereum.Value[] = [
      ethereum.Value.fromBoolean(sign),
      ethereum.Value.fromUnsignedBigInt(value)
    ]
    return new ValueStruct(values)
  }

  neg(): ValueStruct {
    return ValueStruct.fromFields(!this.sign, this.value)
  }

  abs(): ValueStruct {
    return ValueStruct.fromFields(true, this.value.abs())
  }

  applied(): BigInt {
    return this.sign ? this.value : this.value.neg()
  }
}

export class MarginPositionStatus {
  // eslint-disable-next-line
  static Open: string = 'OPEN'
  // eslint-disable-next-line
  static Closed: string = 'CLOSED'
  // eslint-disable-next-line
  static Expired: string = 'EXPIRED'
  // eslint-disable-next-line
  static Liquidated: string = 'LIQUIDATED'
  // eslint-disable-next-line
  static Unknown: string = 'UNKNOWN'

  static isClosed(position: MarginPosition): boolean {
    return position.status != MarginPositionStatus.Open
  }
}
