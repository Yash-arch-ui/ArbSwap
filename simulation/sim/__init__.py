"""ArbSwap simulator package (Build Plan §8, tasks T1.4-T1.6).

Implemented modules:
  - ``price_source``: 1s reference replay + synthetic regimes (calm/trend/crash/jump)
  - ``oracle``: latency + noise oracle with a confidence interval
  - ``flow``: Poisson noise flow and edge-triggered informed arbitrage
  - ``venues``: B1 passive pool, B2 fixed-spread vault, B3/B4 ArbSwap vault
  - ``engine``: deterministic event-driven loop
  - ``metrics``: markouts, quiet flow, hedged PnL, LVR, quote-vs-fill gap
  - ``calibrate``: walk-forward subset selection
  - ``experiments``: E1-E4 runners

Rule (Build Plan §4): the simulator uses the same pricing code as the keeper
(``simulation.reference.quote_math``) so the backtest describes the product.
"""
