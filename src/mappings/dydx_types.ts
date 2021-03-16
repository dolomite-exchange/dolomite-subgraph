import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts/index'
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