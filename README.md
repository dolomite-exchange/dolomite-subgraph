# Dolomite Subgraph

This sub-graph was originally forked from [Uniswap](https://uniswap.org/). Dolomite is a decentralized protocol for 
complex financial instruments on Ethereum. Elements of Uniswap's AMM design were forked and integrated into Dolomite's 
fork of [dYdX's Solo Margin](https://github.com/dydxprotocol/solo). 

This subgraph dynamically tracks all trading pairs. It tracks of the current state of Uniswap contracts, the 
DolomiteMargin margin protocol, and contains derived stats for things like historical data and USD prices.

- aggregated data across pairs and tokens,
- data on individual pairs and tokens,
- data on transactions
- data on liquidity providers
- data on liquidations and vaporizations
- data on the health of each user's (margin) account
- historical data on Dolomite, pairs or tokens, aggregated by day

## Running Locally

Make sure to update package.json settings to point to your own graph account.

## Queries

Below are a few ways to show how to query the uniswap-subgraph for data. The queries show most of the information that 
is queryable, but there are many other filtering options that can be used, just check out the 
[querying api](https://thegraph.com/docs/graphql-api). These queries can be used locally or in The Graph Explorer 
playground.

## Key Entity Overviews

#### UniswapFactory

Contains data across all of Uniswap V2. This entity tracks important things like total liquidity (in ETH and USD, see 
below), all time volume, transaction count, number of pairs and more.

#### Token

Contains data on a specific token. This token specific data is aggregated across all pairs, and is updated whenever 
there is a transaction involving that token.

#### Pair

Contains data on a specific pair.

#### Transaction

Every transaction on Dolomite is stored. Each transaction contains an array of mints, burns, and swaps that occurred 
within it.

#### Mint, Burn, Swap

These contain specific information about a transaction. Things like which pair triggered the transaction, amounts, 
sender, recipient, and more. Each is linked to a parent Transaction entity.

## Example Queries

### Querying Aggregated Dolomite Data

This query fetches aggregated data from all pairs and tokens, to give a view into how much activity is happening within 
the whole protocol.

```graphql
{
  uniswapFactories(first: 1) {
    pairCount
    totalVolumeUSD
    totalLiquidityUSD
  }
}
```
