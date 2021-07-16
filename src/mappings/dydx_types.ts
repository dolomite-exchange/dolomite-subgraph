import { Address, BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { BI_18, convertTokenToDecimal, ZERO_BI } from './helpers'

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

  static fromFields(sign: boolean, value: BigInt): ValueStruct {
    let values: ethereum.Value[] = [
      ethereum.Value.fromBoolean(sign),
      ethereum.Value.fromUnsignedBigInt(value)
    ]
    return new ValueStruct(values)
  }

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
}
