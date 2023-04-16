# Dolomite Subgraph

This subgraph was originally forked from [Uniswap](https://uniswap.org/). Dolomite is a next-generation money market 
DeFi protocol. 

This subgraph dynamically tracks all markets and trading pairs. It tracks of the current state of the Dolomite Margin 
contracts and contains derived stats for things like historical data and USD prices.

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

#### AmmFactory

Contains data across all of Dolomite AMM pools. This entity tracks important things like total liquidity (in ETH and USD, see 
below), all time volume, transaction count, number of pairs and more.

#### Token

Contains data on a specific token. This token specific data is aggregated across all pairs, and is updated whenever 
there is a transaction involving that token.

#### AmmPair

Contains data on a specific AMM pool.

#### Transaction

Every transaction on Dolomite is stored. Each transaction contains an array of mints, burns, and swaps that occurred 
within it.

#### AmmPair, AmmMint, AmmBurn

These contain specific information about a transaction. Things like which pair triggered the transaction, amounts, 
sender, recipient, and more. Each is linked to a parent Transaction entity.

## Example Queries

### Querying Aggregated Dolomite Data

This query fetches aggregated data from all pairs and tokens, to give a view into how much activity is happening within 
the whole protocol.

```graphql
{
  ammFactories(first: 1) {
    pairCount
    totalVolumeUSD
    totalLiquidityUSD
  }
}
```
