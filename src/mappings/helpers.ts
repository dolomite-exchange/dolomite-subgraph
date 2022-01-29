import { BigDecimal } from '@graphprotocol/graph-ts'
import { ZERO_BD } from './generated/constants'

export function absBD(bd: BigDecimal): BigDecimal {
  if (bd.lt(ZERO_BD)) {
    return bd.neg()
  } else {
    return bd
  }
}
