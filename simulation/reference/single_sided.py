"""Independent Python reference for the single-sided math (Task 2).

Mirrors, bit-for-bit, the on-chain functions in ``vault/program/src/lib.rs``:

- ``charge_fee``          -> :func:`charge_fee`
- ``single_eval``         -> :func:`single_eval`
- ``solve_deposit_single``-> :func:`solve_deposit_single`
- the ``claim_withdraw_single`` amount plan -> :func:`withdraw_single`

The ladder walk itself is the shared reference in
``simulation/reference/ladder.py`` (already differential-tested against the Rust
``arb_math::walk_ladder``). This module therefore adds only the single-sided
*plan* logic on top of the same primitive.

Side convention (identical to the program):

- single-sided **deposit** ``side`` names the **input** token:
  ``"sellBase"`` = base in (internal swap walks the **bid** ladder),
  ``"buyBase"``  = quote in (walks the **ask** ladder).
- single-token **withdraw** ``side`` names the **payout** token:
  ``"buyBase"``  = base out (converts the unwanted quote via the **ask** ladder),
  ``"sellBase"`` = quote out (converts the unwanted base via the **bid** ladder).

All quantities are exact non-negative integers; floating point must never
appear here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

from simulation.reference.ladder import FixedPointError, Level, fee_amount, walk_ladder

Side = Literal["buyBase", "sellBase"]


def _ladder_side(side: Side) -> Literal["ask", "bid"]:
    """The ladder a side walks: pay base -> ask, pay quote -> bid."""
    return "ask" if side == "buyBase" else "bid"


def charge_fee(amount_in: int, fee_bps: int) -> tuple[int, int]:
    """``fee = ceil(amount_in * fee_bps / 10_000)``; ``net = amount_in - fee``."""
    if amount_in < 0:
        raise FixedPointError("negative amount")
    fee = fee_amount(amount_in, fee_bps)
    return fee, amount_in - fee


def _walk_full(levels: Sequence[Level], side: Side, net: int) -> int:
    """Walk the committed ladder, requiring full absorption (as `swap` does)."""
    result = walk_ladder(levels, _ladder_side(side), net)
    if result.remaining != 0:
        raise FixedPointError("ladder cannot absorb the amount")
    return result.out


@dataclass(frozen=True)
class DepositPlan:
    s: int
    fee: int
    swap_out: int
    db: int
    dq: int
    shares: int
    diff: int


def single_eval(
    levels: Sequence[Level],
    side: Side,
    amount_in: int,
    s: int,
    base_net: int,
    quote_net: int,
    total_shares: int,
    fee_bps: int,
) -> DepositPlan | None:
    """Evaluate the balanced-deposit plan for a candidate swapped notional `s`.

    Returns ``None`` when `s` is infeasible (ladder cannot absorb the internal
    swap, or the post-swap net reserve would be non-positive), so the bisection
    shrinks toward feasible notionals.
    """
    if not 0 <= s <= amount_in:
        return None
    fee, s_net = charge_fee(s, fee_bps)
    if side == "sellBase":
        try:
            out = 0 if s_net == 0 else _walk_full(levels, "sellBase", s_net)
        except FixedPointError:
            return None
        bnet2 = base_net + s_net
        qnet2 = quote_net - out
        db = amount_in - s
        dq = out
    else:
        try:
            out = 0 if s_net == 0 else _walk_full(levels, "buyBase", s_net)
        except FixedPointError:
            return None
        bnet2 = base_net - out
        qnet2 = quote_net + s_net
        db = out
        dq = amount_in - s
    if bnet2 <= 0 or qnet2 <= 0:
        return None
    by_base = db * total_shares // bnet2
    by_quote = dq * total_shares // qnet2
    shares = min(by_base, by_quote)
    return DepositPlan(
        s=s,
        fee=fee,
        swap_out=out,
        db=db,
        dq=dq,
        shares=shares,
        diff=by_base - by_quote,
    )


def solve_deposit_single(
    levels: Sequence[Level],
    side: Side,
    amount_in: int,
    base_net: int,
    quote_net: int,
    total_shares: int,
    fee_bps: int,
) -> DepositPlan:
    """Bounded integer bisection (<= 64 steps) for the balanced swapped notional.

    ``diff(s)`` is monotone (decreasing for ``sellBase``, increasing for
    ``buyBase``); the two integers adjacent to the crossing are compared directly
    so the maximum-``min`` plan is returned. Mirrors ``solve_deposit_single``.
    """
    def ev(candidate: int) -> DepositPlan | None:
        return single_eval(
            levels, side, amount_in, candidate, base_net, quote_net,
            total_shares, fee_bps,
        )

    lo, hi = 0, amount_in
    if side == "sellBase":
        # Largest `s` with diff(s) >= 0.
        while lo < hi:
            mid = lo + (hi - lo + 1) // 2
            plan = ev(mid)
            if plan is not None and plan.diff >= 0:
                lo = mid
            else:
                hi = mid - 1
    else:
        # Smallest `s` with diff(s) >= 0.
        while lo < hi:
            mid = lo + (hi - lo) // 2
            plan = ev(mid)
            if plan is not None and plan.diff >= 0:
                hi = mid
            else:
                lo = mid + 1
    best: DepositPlan | None = None
    for delta in (0, -1, 1):
        candidate = lo + delta
        if not 0 <= candidate <= amount_in:
            continue
        plan = ev(candidate)
        if plan is not None and (best is None or plan.shares > best.shares):
            best = plan
    if best is None:
        raise FixedPointError("no feasible deposit plan")
    return best


@dataclass(frozen=True)
class WithdrawPlan:
    base_out: int
    quote_out: int
    unwanted: int
    fee: int
    swap_net: int
    converted: int
    payout: int


def withdraw_single(
    levels: Sequence[Level],
    side: Side,
    shares: int,
    base_net: int,
    quote_net: int,
    total_shares: int,
    fee_bps: int,
) -> WithdrawPlan:
    """The ``claim_withdraw_single`` amount plan.

    Pro-rata floors for both tokens, then the unwanted leg is converted through
    the ladder (same fee / walk as the deposit path). ``side`` is the payout
    token. Raises :class:`FixedPointError` if the ladder cannot absorb the
    conversion (the program reverts with ``CapacityExceeded`` and leaves the
    ticket intact).
    """
    if total_shares <= 0:
        raise FixedPointError("invalid withdraw state")
    base_out = shares * base_net // total_shares
    quote_out = shares * quote_net // total_shares
    unwanted = quote_out if side == "buyBase" else base_out
    fee, swap_net = charge_fee(unwanted, fee_bps)
    converted = _walk_full(levels, side, swap_net) if swap_net > 0 else 0
    payout = (base_out + converted) if side == "buyBase" else (quote_out + converted)
    return WithdrawPlan(
        base_out=base_out,
        quote_out=quote_out,
        unwanted=unwanted,
        fee=fee,
        swap_net=swap_net,
        converted=converted,
        payout=payout,
    )
