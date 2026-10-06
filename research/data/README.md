# Research data

**Download scripts only — no raw data in git** (Build Plan §4).

Planned sources (Build Plan §8.6; access to be confirmed in P0/T0.4):
- 1-second top-of-book reference prices from a major CEX
  (the propAMM paper used Bybit's public order-book archive; Binance klines are an alternative).
- Pyth historical prices for the oracle side.
- Optional on-chain Solana swap data for E8 (quote-vs-fill gap on real pools).

Scripts will live here as `download_*.py` and write to `raw/` (git-ignored).
