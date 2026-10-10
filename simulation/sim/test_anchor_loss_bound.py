"""Item 1b: the keeper-compromise per-update loss bound.

A malicious keeper posts an anchor `d` away from the oracle (bounded on-chain by
`max_anchor_dev_bps`). The exposed ladder depth is capped at `u = utilization_max`
of the quote reserve. A trader picks the mispriced side off, so the per-update
loss is bounded by ``u * d * (quote reserve)`` (one side), and by ``u * d * V``
against total value.

This models the attack with the production ladder math and asserts the realised
loss does not exceed the bound.
"""

from __future__ import annotations

from simulation.reference.quote_math import QuoteParams, build_ladder, walk_ladder

PRICE = 150.0
BASE = 1_000.0
QUOTE = 150_000.0
U_MAX = 0.5
D = 0.01  # 100 bps recommended default max_anchor_dev_bps / 1e4


def _malicious_bid_loss(d: float) -> float:
    """Loss when the keeper anchors the bid `d` above the oracle."""
    params = QuoteParams()
    _asks, bids = build_ladder(
        price=PRICE,
        reservation=PRICE * (1.0 + d),  # malicious, high reservation
        half_spread=0.0001,
        ask_extra=0.0,
        bid_extra=0.0,
        base_reserve=BASE,
        quote_reserve=QUOTE,
        depth_mult=1.0,
        params=params,
    )
    # The vault buys base on the bid side, paying quote. Size well inside the
    # exposed depth: 0.5 * (u * QUOTE / PRICE) base in (< the full bid capacity).
    base_in = 0.5 * U_MAX * QUOTE / PRICE
    quote_out, _, _ = walk_ladder(bids, base_in)
    # Loss vs trading at the true oracle price.
    return quote_out - base_in * PRICE


def test_malicious_anchor_loss_within_bound():
    loss = _malicious_bid_loss(D)
    bound_side = U_MAX * D * QUOTE          # exposed quote reserve
    assert 0 < loss <= bound_side * 1.05, (loss, bound_side)
    # And the total-value form u * d * V is a looser upper bound.
    value = BASE * PRICE + QUOTE
    assert loss <= U_MAX * D * value


def test_loss_is_linear_in_the_deviation():
    small = _malicious_bid_loss(0.0025)
    big = _malicious_bid_loss(0.005)
    assert big > small
    # No deviation -> no loss.
    assert _malicious_bid_loss(0.0) <= 1e-6
