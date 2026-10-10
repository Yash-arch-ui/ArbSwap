"""C4.4 - hedged-profit performance fee with a high-water mark (OFF-CHAIN).

The on-chain MVP takes a fixed share of **trading fees** only (Build Plan §5.15).
This module computes the *roadmap* fee on **hedged** profit with a
**high-water mark** as an off-chain attribution report. Moving it on-chain is
roadmap (CLOSED-BY-DECISION, `docs/ANALYTICS.md`).

Hedged profit is the input (fees minus LVR, beta stripped) — never raw LP PnL.
"""

from __future__ import annotations


def hedged_profit_fee(epoch_hedged_pnl, *, hwm: float = 0.0,
                      rate_bps: int = 2_000) -> list[float]:
    """Fee per epoch, charged only on profit above the running high-water mark.

    ``epoch_hedged_pnl`` is the per-epoch hedged profit (quote units). The fee is
    ``rate_bps`` of the increment by which cumulative hedged profit exceeds the
    prior peak; the peak then rises to the new cumulative profit. No fee is
    charged in a losing or below-peak epoch.
    """
    if rate_bps < 0:
        raise ValueError("rate_bps must be non-negative")
    cum = 0.0
    high = float(hwm)
    fees: list[float] = []
    for pnl in epoch_hedged_pnl:
        cum += pnl
        if cum > high:
            fee = (cum - high) * rate_bps / 10_000.0
            high = cum
        else:
            fee = 0.0
        fees.append(fee)
    return fees


def insurance_buffer(path, *, cap: float | None = None) -> list[float]:
    """Running insurance buffer from per-epoch contributions and losses.

    Invariant (tested): the buffer is never negative and never exceeds ``cap``.
    The buffer is **not** claimable by the treasury (program-side:
    ``insurance_bucket_cannot_be_claimed_to_treasury``).
    """
    buf = 0.0
    out: list[float] = []
    for delta in path:
        buf += delta
        if buf < 0:
            buf = 0.0  # losses beyond the buffer hit LPs, not a negative buffer
        if cap is not None and buf > cap:
            buf = cap
        out.append(buf)
    return out
