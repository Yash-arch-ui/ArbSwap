"""Bootstrap confidence intervals for hedged PnL (Amendment 1).

Hedged PnL is a sum of per-step increments; resampling the increments with
replacement gives a CI for the total without distributional assumptions.
"""

from __future__ import annotations

import random


def hedged_increments(value_path, base_path, price_path):
    out = []
    for t in range(len(value_path) - 1):
        hedge = base_path[t] * (price_path[t + 1] - price_path[t])
        out.append((value_path[t + 1] - value_path[t]) - hedge)
    return out


def bootstrap_ci(increments, *, n=10_000, seed=20261006, lo=0.025, hi=0.975):
    if not increments:
        return (0.0, 0.0, 0.0)
    total = sum(increments)
    rng = random.Random(seed)
    m = len(increments)
    draws = []
    for _ in range(n):
        draws.append(sum(increments[rng.randrange(m)] for _ in range(m)))
    draws.sort()
    return (total, draws[int(lo * n)], draws[int(hi * n)])
