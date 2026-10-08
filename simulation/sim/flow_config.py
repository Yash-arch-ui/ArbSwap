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


def pool_kwargs() -> dict:
    base = BASE0 * DEPTH_MULT
    return {"base": base, "quote": base * PRICE0}
