import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { BI_18, convertTokenToDecimal, ZERO_BI } from './helpers'
import { EthereumTuple, EthereumValue } from '@graphprotocol/graph-ts/index'

export class BalanceUpdate {

  accountOwner: Address
  accountNumber: BigInt
  market: BigInt
  valuePar: BigDecimal

  constructor(
    accountOwner: Address,
    accountNumber: BigInt,
    market: BigInt,
    valuePar: BigInt,
    sign: boolean
  ) {
    this.accountOwner = accountOwner
    this.accountNumber = accountNumber
    this.market = market
    if (sign) {
      this.valuePar = convertTokenToDecimal(valuePar, BI_18)
    } else {
      this.valuePar = convertTokenToDecimal(ZERO_BI.minus(valuePar), BI_18)
    }
  }

}

export class ValueStruct {

  private tuple: EthereumTuple

  constructor(tuple: EthereumTuple) {
    this.tuple = tuple
  }

  get sign(): boolean {
    return this.tuple[0].toBoolean()
  }

  get value(): BigInt {
    return this.tuple[1].toBigInt()
  }

  abs(): ValueStruct {
    return ValueStruct.fromFields(true, this.value.abs())
  }

  static fromFields(sign: boolean, value: BigInt): ValueStruct {
    return new ValueStruct(new EthereumTuple(
      EthereumValue.fromBoolean(sign),
      EthereumValue.fromUnsignedBigInt(value)
    ))
  }
}
