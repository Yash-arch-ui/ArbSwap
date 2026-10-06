# Analytics (indexer + metrics)

Status: skeleton (P4). Per Build Plan §9:

- **Indexer:** subscribe to program logs, parse events (`QuoteUpdated`, `Swap`,
  `Deposit`, `WithdrawRequested`, `WithdrawClaimed`, `BreakerTripped`,
  `BreakerReset`, `KeeperSlashed`, `ParamsChanged` — every event carries slot
  and version), store with slot + timestamp, reconcile against account state.
- **Metrics engine:** 2s notional-weighted markouts (-5..+15s curve), LVR avoided
  vs passive benchmark, quote-versus-fill gap (honesty metric; mean, volume-weighted
  mean, share identical, tail), quiet-flow half-spread (<1 bps reference move from
  -5s to +1s), hedged return = fees - LVR, attribution (fees, LVR, inventory, gas).

Stack: Python or TypeScript (Build Plan §4); Postgres or ClickHouse.
