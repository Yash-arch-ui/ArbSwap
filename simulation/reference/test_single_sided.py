"""Task 2 tests for the single-sided reference.

Three independent checks:

1. The generated golden-vector file is exactly reproducible from the reference
   (the Rust side parses the same file, so this is the cross-language contract).
2. The bisection solver returns the same maximum-``min`` plan as an exhaustive
   scan over every candidate ``s`` (independent of the golden vectors).
3. Fuzz invariants over wide ranges: fee is exactly the swap fee, notional is
   conserved, no value is created, and the solver is locally maximal.
"""

from __future__ import annotations

import random
from decimal import Decimal, ROUND_CEILING
from pathlib import Path

import pytest

from simulation.reference.ladder import FixedPointError, Level
from simulation.reference.single_sided import (
    charge_fee,
    single_eval,
    solve_deposit_single,
    withdraw_single,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "vault" / "program" / "tests"
    / "single_sided_vectors.txt"
)
Q64 = 1 << 64


def _load_vectors() -> list[dict[str, int | str]]:
    cases: list[dict[str, int | str]] = []
    for line in VECTORS_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|")
        case: dict[str, int | str] = {"kind": parts[0]}
        for part in parts[1:]:
            key, value = part.split("=", 1)
            case[key] = value if key == "side" else int(value)
        cases.append(case)
    return cases


def _levels(case: dict[str, int | str]) -> list[Level]:
    nlev = int(case["nlev"])
    return [
        Level(
            sqrt_lo=int(case[f"lo{i}"]),
            sqrt_hi=int(case[f"hi{i}"]),
            liquidity=int(case[f"liq{i}"]),
        )
        for i in range(nlev)
    ]


def _side_from_deposit(case: dict[str, int | str]) -> str:
    return "sellBase" if case["side"] == "sellBase" else "buyBase"


def test_golden_vector_file_exists_and_is_large() -> None:
    cases = _load_vectors()
    deposits = sum(1 for c in cases if c["kind"] == "deposit")
    withdraws = sum(1 for c in cases if c["kind"] == "withdraw")
    assert len(cases) >= 500
    assert deposits >= 200
    assert withdraws >= 100


def test_golden_vectors_reproduce_from_reference() -> None:
    for case in _load_vectors():
        levels = _levels(case)
        side = _side_from_deposit(case)
        fee_bps = int(case["fee_bps"])
        if case["kind"] == "deposit":
            plan = solve_deposit_single(
                levels,
                side,
                int(case["amount_in"]),
                int(case["base_net"]),
                int(case["quote_net"]),
                int(case["total_shares"]),
                fee_bps,
            )
            assert plan.s == case["s"]
            assert plan.fee == case["fee"]
            assert plan.swap_out == case["swap_out"]
            assert plan.db == case["db"]
            assert plan.dq == case["dq"]
            assert plan.shares == case["shares"]
            assert plan.diff == case["diff"]
        else:
            plan = withdraw_single(
                levels,
                side,
                int(case["shares"]),
                int(case["base_net"]),
                int(case["quote_net"]),
                int(case["total_shares"]),
                fee_bps,
            )
            assert plan.base_out == case["base_out"]
            assert plan.quote_out == case["quote_out"]
            assert plan.unwanted == case["unwanted"]
            assert plan.fee == case["fee"]
            assert plan.swap_net == case["net"]
            assert plan.converted == case["converted"]
            assert plan.payout == case["payout"]


def _brute_best(levels: list[Level], side: str, amount_in: int, base_net: int,
                quote_net: int, total_shares: int, fee_bps: int) -> int:
    best = 0
    for s in range(amount_in + 1):
        plan = single_eval(
            levels, side, amount_in, s, base_net, quote_net, total_shares, fee_bps
        )
        if plan is not None:
            best = max(best, plan.shares)
    return best


def test_solver_matches_brute_force() -> None:
    rng = random.Random(20261016)
    for _ in range(3_000):
        capacity = rng.randint(64, 127)
        level = Level(
            sqrt_lo=1 << 64, sqrt_hi=2 << 64, liquidity=capacity << 64
        )
        side = rng.choice(["sellBase", "buyBase"])
        fee_bps = rng.choice([0, 1, 5, 10, 30, 50, 100])
        amount_in = rng.randint(1, 32)
        base_net = rng.randint(1_000, 1_000_000)
        quote_net = rng.randint(1_000, 1_000_000)
        total_shares = rng.randint(1_000, 1_000_000)
        solved = solve_deposit_single(
            [level], side, amount_in, base_net, quote_net, total_shares, fee_bps
        )
        brute = _brute_best(
            [level], side, amount_in, base_net, quote_net, total_shares, fee_bps
        )
        assert solved.shares == brute


def test_wide_fuzz_invariants() -> None:
    rng = random.Random(0xC0FFEE)
    checked = 0
    while checked < 3_000:
        nlev = rng.randint(1, 3)
        levels: list[Level] = []
        sqrt = 1 << 64
        for _ in range(nlev):
            width = rng.randint(1, 1 << 64)
            levels.append(
                Level(sqrt_lo=sqrt, sqrt_hi=sqrt + width,
                      liquidity=10 ** rng.randint(18, 24))
            )
            sqrt += width
        side = rng.choice(["sellBase", "buyBase"])
        # Keep the traded notional inside the ladder so every candidate is
        # feasible (the solver otherwise correctly reports CapacityExceeded).
        ladder_side = "bid" if side == "sellBase" else "ask"
        capacity = sum(level.max_input(ladder_side) for level in levels)
        if capacity < 1:
            continue
        checked += 1
        fee_bps = rng.choice([0, 1, 5, 10, 30, 50, 100])
        base_net = rng.randint(10_000, 10 ** 12)
        quote_net = rng.randint(10_000, 10 ** 12)
        total_shares = rng.randint(10_000, 10 ** 12)
        amount_in = rng.randint(1, capacity)
        plan = solve_deposit_single(
            levels, side, amount_in, base_net, quote_net, total_shares, fee_bps
        )
        assert plan.fee == -(-plan.s * fee_bps // 10_000)
        if plan.s > 0:
            assert plan.fee <= plan.s
        if side == "sellBase":
            assert plan.db + plan.s == amount_in
            assert plan.dq == plan.swap_out
        else:
            assert plan.dq + plan.s == amount_in
            assert plan.db == plan.swap_out
        # No dilution: the reported plan is exactly the one `single_eval`
        # produces, hence shares never exceed the vault-favoured floors.
        reference = single_eval(
            levels, side, amount_in, plan.s, base_net, quote_net,
            total_shares, fee_bps,
        )
        assert reference is not None
        assert plan.shares == reference.shares
        assert reference.s == plan.s
        # Local maximality over the adjacent candidates.
        for cand in (plan.s - 1, plan.s, plan.s + 1):
            if not 0 <= cand <= amount_in:
                continue
            other = single_eval(
                levels, side, amount_in, cand, base_net, quote_net,
                total_shares, fee_bps,
            )
            if other is not None:
                assert other.shares <= plan.shares


def test_withdraw_conserves_and_charges_swap_fee() -> None:
    rng = random.Random(0xBEEF)
    for _ in range(2_000):
        level = Level(sqrt_lo=1 << 64, sqrt_hi=2 << 64, liquidity=(64 + rng.randint(0, 63)) << 64)
        side = rng.choice(["sellBase", "buyBase"])
        fee_bps = rng.choice([0, 1, 5, 10, 30, 50, 100])
        base_net = rng.randint(1_000, 10 ** 9)
        quote_net = rng.randint(1_000, 10 ** 9)
        total_shares = rng.randint(1_000, 10 ** 9)
        shares = rng.randint(1, total_shares)
        try:
            plan = withdraw_single(
                [level], side, shares, base_net, quote_net, total_shares, fee_bps
            )
        except FixedPointError:
            continue
        wanted = plan.base_out if side == "buyBase" else plan.quote_out
        assert plan.payout == wanted + plan.converted
        assert plan.unwanted == (
            plan.quote_out if side == "buyBase" else plan.base_out
        )
        assert plan.fee == -(-plan.unwanted * fee_bps // 10_000)
        assert plan.swap_net == plan.unwanted - plan.fee
        assert plan.base_out == shares * base_net // total_shares
        assert plan.quote_out == shares * quote_net // total_shares


def test_fee_matches_high_precision_decimal() -> None:
    rng = random.Random(0xFEE)
    for _ in range(2_000):
        amount = rng.randint(0, 10 ** 12)
        fee_bps = rng.randint(0, 1_000)
        expected = int(
            (Decimal(amount) * Decimal(fee_bps) / Decimal(10_000)).to_integral_value(
                rounding=ROUND_CEILING
            )
        )
        fee, net = charge_fee(amount, fee_bps)
        assert fee == expected
        assert net == amount - fee


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
