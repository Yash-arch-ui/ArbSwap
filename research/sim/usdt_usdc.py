"""USDT -> USDC reference conversion (Task 1.1).

Binance quotes SOL against USDT and USDC against USDT. The vault's quote token
is USDC, so the honest reference price is

    P_USDC(t) = P_SOL/USDT(t) / P_USDC/USDT(t)

using the USDC/USDT mid as the conversion rate. Dividing (not multiplying) is
the point: USDC/USDT is quote-per-USDC in USDT, so one USDC buys that many
USDT, and SOL priced in USDT divided by that rate gives SOL per USDC.

The two legs must be sampled on the same grid; :func:`convert_legs` refuses to
guess at misaligned inputs rather than silently padding them.
"""

from __future__ import annotations

from research.sim.price_source import PricePoint

# Guard rails. USDC is a fiat stablecoin: anything outside this band means the
# two legs were not aligned (or the feed broke) and the conversion is unusable.
MIN_PEG = 0.90
MAX_PEG = 1.10


def convert_price(price_usdt: float, usdc_usdt: float) -> float:
    """SOL (or any asset) priced in USDC from its USDT price and the USDC/USDT mid."""
    if price_usdt <= 0:
        raise ValueError("price_usdt must be positive")
    if usdc_usdt <= 0:
        raise ValueError("usdc_usdt must be positive")
    return price_usdt / usdc_usdt


def convert_legs(sol_usdt: list[PricePoint], usdc_usdt: list[PricePoint],
                 *, min_peg: float = MIN_PEG, max_peg: float = MAX_PEG) -> list[PricePoint]:
    """Divide a SOL/USDT leg by a USDC/USDT leg sampled on the same grid.

    Raises on length mismatch or a peg outside ``[min_peg, max_peg]``: a silent
    misalignment would shift every price in the study.
    """
    if len(sol_usdt) != len(usdc_usdt):
        raise ValueError(
            f"legs must be the same length (got {len(sol_usdt)} and {len(usdc_usdt)})"
        )
    if not sol_usdt:
        raise ValueError("legs must be non-empty")
    out: list[PricePoint] = []
    for point, peg in zip(sol_usdt, usdc_usdt):
        if point.second != peg.second:
            raise ValueError(
                f"legs are not aligned at index {point.second} vs {peg.second}"
            )
        if not min_peg <= peg.price <= max_peg:
            raise ValueError(f"USDC/USDT peg {peg.price} outside [{min_peg}, {max_peg}]")
        out.append(PricePoint(second=point.second,
                              price=convert_price(point.price, peg.price)))
    return out
