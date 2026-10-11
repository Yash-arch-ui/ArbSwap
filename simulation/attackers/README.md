# Attacker bots (adversarial testing, E7) — Phase 5

Status: implemented (T5.1). `attackers/` now contains the E7 scenario bots.

## Contents

- `scenarios.py` — seven bots + a `keeper_alive` control. Each takes an
  attacker's point of view (chosen oracle latency, keeper cadence, or order
  flow) and drives the verified simulator.
- `e7.py` — `python -m attackers.e7`: prints the containment table (gap,
  markout, passive-pool counterfactual, LVR reduction E1).
- `tests/test_e7.py` — structural containment assertions:
  - honest fill is never **worse** than the last displayed quote (gap ≤ ~0);
  - the B4 no-honesty ablation shows a *positive* (worse) gap vs the honest
    vault;
  - a dead keeper (no updates after init) stops fills once quotes expire.

## Bots (mapped to THREAT_MODEL and the on-chain suite)

1. **stale-feed** — oracle frozen; staleness/confidence widening + expiry.
2. **bad-tick** — volatility spike; jump detection + depth throttle + the
   on-chain anchor-step guard.
3. **sandwich / pick-off** — versioned quotes + `min_out`.
4. **phantom-liquidity** — warm-up + epoch queue + utilization cap.
5. **keeper-down** — quote expiry stops fills; breaker.
6. **adaptive toxic flow** — spread floor + throttle + expiry.
7. **sandwich around oracle update** — versioned quotes.

Account/authority attacks that cannot be expressed in the liquidity simulator
are contained and tested on-chain in `programs/arbswap/tests`
(`litesvm_lifecycle.rs`, `litesvm_security.rs`, `litesvm_breaker.rs`), e.g.
stale/wrong-feed Pyth accounts, anchored-level (bad-tick) rejection, Token-2022
rejection, donation / share-inflation, bond/slash/reward, and warm-up.

## Run

```bash
.venv/bin/python -m pytest attackers -q
.venv/bin/python -m attackers.e7
```

Gate (P5): every E7 attack fails or is contained, and is documented — see
`docs/CLAIMS.md`.