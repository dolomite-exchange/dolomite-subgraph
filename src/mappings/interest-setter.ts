import { BigDecimal, BigInt, Bytes, ethereum, log } from '@graphprotocol/graph-ts'
import { DolomiteMargin, InterestIndex, InterestRate, Token, TotalPar } from '../types/schema'
import { INTEREST_PRECISION, ONE_ETH_BD, ONE_ETH_BI, SECONDS_IN_YEAR, TEN_BI, ZERO_BI } from './generated/constants'
import { absBD } from './helpers'
import { parToWei } from './margin-helpers'

const SECONDS_IN_YEAR_BI = BigInt.fromString('31536000')
const PERCENT = BigInt.fromString('100')

function getDoubleExponentInterestRate(borrowWei: BigInt, supplyWei: BigInt): BigInt {
  if (borrowWei.equals(ZERO_BI)) {
    return ZERO_BI
  }

  let maxAPR = ONE_ETH_BI // 1.00 --> 100%
  if (borrowWei.ge(supplyWei)) {
    return maxAPR.div(SECONDS_IN_YEAR_BI)
  }

  let coefficients = [0, 20, 0, 0, 0, 0, 20, 60]
  let result = BigInt.fromI32(coefficients[0]).times(ONE_ETH_BI)
  let polynomial = ONE_ETH_BI.times(borrowWei).div(supplyWei)
  for (let i = 1; i < coefficients.length; i++) {
    let coefficient = coefficients[i]
    // if non-zero, add to result
    if (coefficient !== 0) {
      result = result.plus(BigInt.fromI32(coefficient).times(polynomial))
    }
    polynomial = polynomial.times(polynomial).div(ONE_ETH_BI)
  }

  return result.times(maxAPR).div(SECONDS_IN_YEAR_BI.times(ONE_ETH_BI).times(PERCENT))
}

/**
 * @param token
 * @param totalPar
 * @param index
 * @param dolomiteMargin
 * @param event           Used for getting the block number so we can potentially calculate the interest rate
 *                        differently, if another interest setter implementation is set in the future.
 */
export function updateInterestRate(
  token: Token,
  totalPar: TotalPar,
  index: InterestIndex,
  dolomiteMargin: DolomiteMargin,
  event: ethereum.Event
): void {
  let borrowWei = absBD(parToWei(totalPar.borrowPar.neg(), index, token.decimals))
  let supplyWei = parToWei(totalPar.supplyPar, index, token.decimals)

  borrowWei = borrowWei.times(new BigDecimal(TEN_BI.pow(token.decimals.toI32() as u8)))
  supplyWei = supplyWei.times(new BigDecimal(TEN_BI.pow(token.decimals.toI32() as u8)))

  let borrowWeiBI = borrowWei.digits.times(TEN_BI.pow(borrowWei.exp.toI32() as u8))
  let supplyWeiBI = supplyWei.digits.times(TEN_BI.pow(supplyWei.exp.toI32() as u8))

  let interestRate = InterestRate.load(index.token) as InterestRate
  let interestRatePerSecond = getDoubleExponentInterestRate(borrowWeiBI, supplyWeiBI)
  let interestPerYearBD = new BigDecimal(interestRatePerSecond.times(SECONDS_IN_YEAR))
  interestRate.borrowInterestRate = interestPerYearBD.div(ONE_ETH_BD)

  // set the supplyInterestRate
  if (borrowWei.lt(supplyWei)) {
    // the supply interest rate is spread across the supplied balance, which is paid on the borrow amount. Therefore,
    // the interest owed must be scaled down by the supplied we vs owed wei
    interestRate.supplyInterestRate = interestRate.borrowInterestRate
      .times(dolomiteMargin.earningsRate)
      .truncate(INTEREST_PRECISION)
      .times(borrowWei)
      .div(supplyWei)
      .truncate(INTEREST_PRECISION)
  } else {
    interestRate.supplyInterestRate = interestRate.borrowInterestRate
      .times(dolomiteMargin.earningsRate)
      .truncate(INTEREST_PRECISION)
  }

  interestRate.save()
}
