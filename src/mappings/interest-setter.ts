import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { DolomiteMargin, InterestIndex, InterestRate, Token, TotalPar } from '../types/schema'
import {
  AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS,
  AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS,
  DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS,
  ALWAYS_ZERO_INTEREST_SETTER_ADDRESS,
  INTEREST_PRECISION,
  ONE_ETH_BD,
  ONE_ETH_BI,
  SECONDS_IN_YEAR,
  TEN_BI,
  ZERO_BI,
} from './generated/constants'
import { absBD } from './helpers'
import { parToWei } from './margin-helpers'

const SECONDS_IN_YEAR_BI = BigInt.fromString('31536000')
const PERCENT = BigInt.fromString('100')

export function getAAVECopyCatInterestRatePerSecond(
  isStableCoin: boolean,
  borrowWei: BigInt,
  supplyWei: BigInt,
): BigInt {
  const BASE = ONE_ETH_BI // 100%
  if (borrowWei.equals(ZERO_BI)) {
    return ZERO_BI
  }
  if (supplyWei.equals(ZERO_BI)) {
    // totalBorrowed > 0
    // return BASE.dividedToIntegerBy(INTEGERS.ONE_YEAR_IN_SECONDS).div(BASE);
    return BASE.div(SECONDS_IN_YEAR_BI).times(PERCENT)
  }

  const utilization = BASE.times(borrowWei).div(supplyWei)
  const NINETY_PERCENT = BASE.times(BigInt.fromI32(90)).div(PERCENT)
  const TEN_PERCENT = BASE.times(BigInt.fromI32(10)).div(PERCENT)
  const INITIAL_GOAL = BASE.times(isStableCoin ? BigInt.fromI32(4) : BigInt.fromI32(7)).div(PERCENT)

  let aprBI: BigInt // expressed as 1.0 == 1e18 or 0.1 = 1e17
  if (utilization.ge(BASE)) {
    // utilization exceeds 100%
    aprBI = BASE
  } else if (utilization.gt(NINETY_PERCENT)) {
    // interest is equal to INITIAL_GOAL% + linear progress to 100% APR
    const deltaToGoal = BASE.minus(INITIAL_GOAL)
    const interestToAdd = deltaToGoal.times(utilization.minus(NINETY_PERCENT)).div(TEN_PERCENT)
    aprBI = interestToAdd.plus(INITIAL_GOAL)
  } else {
    aprBI = INITIAL_GOAL.times(utilization).div(NINETY_PERCENT)
  }

  return aprBI.div(SECONDS_IN_YEAR_BI)
}

function getDoubleExponentInterestRatePerSecond(borrowWei: BigInt, supplyWei: BigInt): BigInt {
  if (borrowWei.equals(ZERO_BI)) {
    return ZERO_BI
  }

  let maxAPR = ONE_ETH_BI // 1.00 --> 100%
  if (borrowWei.ge(supplyWei)) {
    return maxAPR.div(SECONDS_IN_YEAR_BI)
  }

  let coefficients: Array<i32> = [0, 20, 0, 0, 0, 0, 20, 60]
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

function getInterestRatePerSecond(
  borrowWeiBI: BigInt,
  supplyWeiBI: BigInt,
  interestSetter: Address,
): BigInt {
  if (interestSetter.equals(Address.fromString(DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS))) {
    return getDoubleExponentInterestRatePerSecond(borrowWeiBI, supplyWeiBI)
  } else if (interestSetter.equals(Address.fromString(AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return getAAVECopyCatInterestRatePerSecond(false, borrowWeiBI, supplyWeiBI)
  } else if (interestSetter.equals(Address.fromString(AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return getAAVECopyCatInterestRatePerSecond(true, borrowWeiBI, supplyWeiBI)
  } else if (interestSetter.equals(Address.fromString(ALWAYS_ZERO_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else {
    throw new Error('Invalid interest setter: ' + interestSetter.toHexString())
  }
}

/**
 * @param token
 * @param totalPar
 * @param index
 * @param dolomiteMargin
 */
export function updateInterestRate(
  token: Token,
  totalPar: TotalPar,
  index: InterestIndex,
  dolomiteMargin: DolomiteMargin,
): void {
  let borrowWei = absBD(parToWei(totalPar.borrowPar.neg(), index, token.decimals))
  let supplyWei = parToWei(totalPar.supplyPar, index, token.decimals)

  borrowWei = borrowWei.times(new BigDecimal(TEN_BI.pow(token.decimals.toI32() as u8)))
  supplyWei = supplyWei.times(new BigDecimal(TEN_BI.pow(token.decimals.toI32() as u8)))

  let borrowWeiBI = borrowWei.digits.times(TEN_BI.pow(borrowWei.exp.toI32() as u8))
  let supplyWeiBI = supplyWei.digits.times(TEN_BI.pow(supplyWei.exp.toI32() as u8))

  let interestRate = InterestRate.load(index.token) as InterestRate
  let interestRatePerSecond = getInterestRatePerSecond(
    borrowWeiBI,
    supplyWeiBI,
    Address.fromString(interestRate.interestSetter.toHexString()),
  )
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
