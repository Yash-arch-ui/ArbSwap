"""ArbSwap simulator package (Build Plan §8, task T1.4).

Modules to land in P1:
  - price source (1s reference replay + synthetic regimes: calm, trend, crash, jump)
  - oracle model (P_oracle(t) = P_ref(t - latency) + noise, with confidence)
  - slot clock (400 ms) with update-landing delay distribution
  - flow model (informed arbitrageur vs Poisson noise flow vs adversarial bots)
  - venues: passive constant-product pool (B1), fixed-spread vault (B2), ArbSwap (B3/B4 ablations)
  - frictions: gas and priority fees per update and swap

Rule (Build Plan §4): the simulator must use the same pricing code as the keeper
so the backtest describes the product.
"""
