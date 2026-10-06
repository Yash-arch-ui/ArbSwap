# THREAT_MODEL.md

Seed from Build Plan §11 (every threat needs a mitigation **and** a test).
Trust model: trusted = Solana runtime, Pyth program/feed (with checks), program
code; semi-trusted = keepers (bounded on-chain); untrusted = traders, LPs, other
programs, RPC nodes. Admin = timelocked params + pause-only kill switch.

| Threat | How it hurts | Mitigation | Test |
|---|---|---|---|
| Stale or lagging oracle | Arbitrageurs pick off old quote | Staleness/confidence widening, breaker, quote expiry | Stale-feed replay (attackers/) |
| Oracle manipulation / bad print | Wrong anchor | Confidence bound, max anchor step, deviation breaker | Bad-tick injection |
| Faster CEX feed than ours | Informational disadvantage | Directional add-on, depth throttle, spread floor | Latency-injection backtest |
| Sandwiching vault swaps | Trader or vault loses | `min_out`, size caps; document private/bundle submission | Sandwich bot (E7) |
| Keeper compromise / downtime | Bad or no updates | On-chain bounds, expiry stops fills, open keeper network | Keeper-kill test |
| Share inflation / donation | Steals from later depositors | Pro-rata shares, MIN_LIQUIDITY burn, rounding favors vault | Fuzz/invariant tests |
| Deposit/withdraw timing games | Phantom depth, run before volatility | Warm-up, epoch withdrawal queue | Timing simulation |
| Account/PDA confusion, missing checks | Funds drained | Anchor constraints, owner/signer/seed checks, no unchecked CPI | Audit checklist, fuzzing |
| Arithmetic overflow / rounding leakage | Value leakage | Checked math, vault-favoring rounding | Property tests |
| Griefing (update/swap spam) | CU/DoS, wear | Update rate limits, reward only valid updates, size minimums | Load test |
| Governance abuse | Param rug | Timelock, config bounds, pause-only kill switch | Review |
| Toxic flow adapts to public rules | Rules gamed | Minimal rules, spread floor, throttle, expiry | Adaptive-attacker test |
| Censoring proposer/builder | Updates suppressed → stale fills | Expiry stops fills, breakers, multiple keepers (A-11) | Keeper-kill + landing-latency test |
| Sandwich around oracle updates | Picks off quotes at update boundaries | Versioned quotes, `min_out`, size caps; study A-06 mitigations | OP-AMM attack bot (E7) |

Solana-specific checklist (Build Plan §11): signer checks on every authority;
owner/address checks on every account incl. the Pyth account (correct program +
feed id); canonical PDA bumps; token accounts verified for mint/owner/program;
reject Token-2022 transfer-changing extensions unless explicitly supported; no
reinitialization; closed accounts zeroed; duplicate-mutable-account review;
hard-coded CPI program ids; checked arithmetic; no unchecked `remaining_accounts`;
indexer reconciles events with state; admin cannot seize funds; keeper bounds
enforced on-chain.
