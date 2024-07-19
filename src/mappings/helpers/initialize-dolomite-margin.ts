import { createLiquidityMiningVesters } from './liquidity-mining-helpers'
import { createEventEmitterRegistries } from './event-emitter-registry-helpers'

export function initializeDolomiteMargin(): void {
  createLiquidityMiningVesters()
  createEventEmitterRegistries()
}
