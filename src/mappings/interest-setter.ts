import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { DolomiteMargin, InterestIndex, InterestRate, Token, TotalPar } from '../types/schema'
import {
  AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS,
  AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS,
  ALWAYS_ZERO_INTEREST_SETTER_ADDRESS,
  DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS,
  INTEREST_PRECISION,
  ONE_ETH_BD,
  ONE_ETH_BI,
  SECONDS_IN_YEAR,
  TEN_BI,
  ZERO_BI,
} from './generated/constants'
import { absBD } from './helpers'
import { parToWei } from './margin-helpers'
import { LinearStepFunctionInterestSetter } from '../types/MarginAdmin/LinearStepFunctionInterestSetter'

const SECONDS_IN_YEAR_BI = BigInt.fromString('31536000')
const PERCENT = BigInt.fromString('100')

export function getOptimalUtilizationRate(interestSetter: Address): BigInt {
  let linearInterestSetterProtocol = LinearStepFunctionInterestSetter.bind(interestSetter)
  let result = linearInterestSetterProtocol.try_OPTIMAL_UTILIZATION()
  let NINETY_PERCENT = BigInt.fromString('900000000000000000') // 0.9e18
  return result.reverted ? NINETY_PERCENT : result.value
}

export function getLowerOptimalRate(interestSetter: Address): BigInt {
  if (interestSetter.equals(Address.fromString(DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else if (interestSetter.equals(Address.fromString(AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return BigInt.fromString('70000000000000000') // 0.07e18
  } else if (interestSetter.equals(Address.fromString(AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return BigInt.fromString('40000000000000000') // 0.04e18
  } else if (interestSetter.equals(Address.fromString(ALWAYS_ZERO_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else {
    // Get it dynamically now
    let linearInterestSetterProtocol = LinearStepFunctionInterestSetter.bind(interestSetter)
    let result = linearInterestSetterProtocol.try_LOWER_OPTIMAL_PERCENT()
    let FOUR_PERCENT = BigInt.fromString('40000000000000000') // 0.04e18
    return result.reverted ? FOUR_PERCENT : result.value
  }
}

export function getUpperOptimalRate(interestSetter: Address): BigInt {
  if (interestSetter.equals(Address.fromString(DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else if (interestSetter.equals(Address.fromString(AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return BigInt.fromString('930000000000000000') // 0.93e18
  } else if (interestSetter.equals(Address.fromString(AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))) {
    return BigInt.fromString('960000000000000000') // 0.96e18
  } else if (interestSetter.equals(Address.fromString(ALWAYS_ZERO_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else {
    // Get it dynamically now
    let linearInterestSetterProtocol = LinearStepFunctionInterestSetter.bind(interestSetter)
    let result = linearInterestSetterProtocol.try_UPPER_OPTIMAL_PERCENT()
    let NINETY_SIX_PERCENT = BigInt.fromString('960000000000000000') // 0.96e18
    return result.reverted ? NINETY_SIX_PERCENT : result.value
  }
}

export function getLinearStepFunctionInterestRatePerSecond(
  optimalUtilization: BigInt,
  lowerOptimalRate: BigInt,
  upperOptimalRate: BigInt,
  borrowWei: BigInt,
  supplyWei: BigInt,
): BigInt {
  const BASE = ONE_ETH_BI // 100%
  if (borrowWei.equals(ZERO_BI)) {
    return ZERO_BI
  }
  if (supplyWei.equals(ZERO_BI)) {
    // totalBorrowed > 0
    return BASE.div(SECONDS_IN_YEAR_BI).times(PERCENT)
  }

  const utilization = BASE.times(borrowWei).div(supplyWei)
  const optimalDeltaToMax = PERCENT.minus(optimalUtilization)
  const initialGoal = lowerOptimalRate
  const maxGoal = lowerOptimalRate.plus(upperOptimalRate)

  let aprBI: BigInt // expressed as 1.0 == 1e18 or 0.1 = 1e17
  if (utilization.ge(BASE)) {
    // utilization matches or exceeds 100%
    aprBI = maxGoal
  } else if (utilization.gt(optimalUtilization)) {
    // interest is equal to initialGoal% + linear progress to maxGoal APR
    const deltaToGoal = maxGoal.minus(initialGoal)
    const interestToAdd = deltaToGoal.times(utilization.minus(optimalUtilization)).div(optimalDeltaToMax)
    aprBI = interestToAdd.plus(initialGoal)
  } else {
    aprBI = initialGoal.times(utilization).div(optimalUtilization)
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
  interestRateObject: InterestRate,
): BigInt {
  const interestSetter = Address.fromHexString(interestRateObject.interestSetter.toHexString())
  if (interestSetter.equals(Address.fromString(DOUBLE_EXPONENT_V1_INTEREST_SETTER_ADDRESS))) {
    return getDoubleExponentInterestRatePerSecond(borrowWeiBI, supplyWeiBI)
  } else if (
    interestSetter.equals(Address.fromString(AAVE_ALT_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))
    || interestSetter.equals(Address.fromString(AAVE_STABLE_COIN_COPY_CAT_V1_INTEREST_SETTER_ADDRESS))
  ) {
    return getLinearStepFunctionInterestRatePerSecond(
      interestRateObject.optimalUtilizationRate,
      interestRateObject.lowerOptimalRate,
      interestRateObject.upperOptimalRate,
      borrowWeiBI,
      supplyWeiBI,
    )
  } else if (interestSetter.equals(Address.fromString(ALWAYS_ZERO_INTEREST_SETTER_ADDRESS))) {
    return ZERO_BI
  } else {
    return getLinearStepFunctionInterestRatePerSecond(
      interestRateObject.optimalUtilizationRate,
      interestRateObject.lowerOptimalRate,
      interestRateObject.upperOptimalRate,
      borrowWeiBI,
      supplyWeiBI,
    )
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
    interestRate,
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
