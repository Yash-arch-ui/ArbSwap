"""Calibrated flow/baseline configuration (T1, docs/P1_PREREGISTRATION.md).

Fitted on the W1 calibration window only so that the passive baseline B1 matches
the paper (2s markout -0.2 bps, quiet half-spread 2.6 bps). ArbSwap is never
tuned here. All venues share this depth (equal starting capital).
"""

from __future__ import annotations

# From simulation/data/results/b1_calibration.json (best fit).
DEPTH_MULT = 12.0
NOISE_MEAN_SIZE = 40.0
NOISE_ARRIVAL_RATE = 0.3

BASE0 = 1_000.0
PRICE0 = 150.0


def pool_kwargs(start_price: float | None = None) -> dict:
    """Venue reserves for equal capital, priced at the path's start.

    ``start_price`` MUST be the first reference price of the run; initializing a
    pool at a hard-coded 150 while the market trades ~100 puts every fill far off
    mid and invalidates the comparison.
    """
    base = BASE0 * DEPTH_MULT
    price = PRICE0 if start_price is None else start_price
    return {"base": base, "quote": base * price}
