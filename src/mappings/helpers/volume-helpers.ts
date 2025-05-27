import {
  DolomiteMargin,
  Token,
  Trade,
} from '../../types/schema'
import { ONE_BI } from '../generated/constants'

export function updateAndSaveVolumeForTrade(
  trade: Trade,
  dolomiteMargin: DolomiteMargin,
  makerToken: Token,
  takerToken: Token,
): void {
  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.takerAmountUSD)
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount.plus(ONE_BI)

  makerToken.tradeVolume = makerToken.tradeVolume.plus(trade.makerTokenDeltaWei)
  makerToken.tradeVolumeUSD = makerToken.tradeVolumeUSD.plus(trade.makerAmountUSD)

  takerToken.tradeVolume = takerToken.tradeVolume.plus(trade.takerTokenDeltaWei)
  takerToken.tradeVolumeUSD = takerToken.tradeVolumeUSD.plus(trade.takerAmountUSD)
}
