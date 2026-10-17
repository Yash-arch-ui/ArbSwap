"""Golden-vector generator for the single-sided math (Task 2).

Writes decimal-integer vectors that the on-chain unit test
(``vault/program/src/lib.rs`` -> ``single_sided_python_differential``) parses and
checks against ``solve_deposit_single`` / the ``claim_withdraw_single`` plan. The
expected values come from the independent Python reference
``simulation/reference/single_sided.py``.

Usage (testing phase):

    python -m simulation.reference.single_sided_golden

Output path defaults to ``vault/program/tests/single_sided_vectors.txt``. Each
line is ``kind|key=value|...`` with decimal integers only; a ``#`` header records
the version/seed/counts. The ladder is symmetric across ask and bid (as in the
program's in-crate vector), with 1-3 levels per case.
"""

from __future__ import annotations

import random
from pathlib import Path

from simulation.reference.ladder import FixedPointError, Level
from simulation.reference.single_sided import (
    solve_deposit_single,
    withdraw_single,
)

Q64 = 1 << 64
DEFAULT_OUTPUT = Path("vault/program/tests/single_sided_vectors.txt")


def _random_ladder(rng: random.Random, nlev: int) -> list[Level]:
    """A monotone ladder of 1-3 contiguous constant-product segments."""
    lo = rng.randint(1 * Q64, 4 * Q64)
    levels: list[Level] = []
    for _ in range(nlev):
        width = rng.randint(Q64 // 50, Q64)  # 2% to 100% price width
        hi = lo + width
        liquidity = rng.randint(10**18, 10**24)
        levels.append(Level(lo, hi, liquidity))
        lo = hi
    return levels


def _internal_capacity(levels: list[Level], side: str) -> int:
    """Ladder capacity for the internal swap input of a deposit side."""
    ladder_side = "ask" if side == "buyBase" else "bid"
    total = 0
    for level in levels:
        total += level.max_input(ladder_side)
    return total


def generate(seed: int = 20261016, deposit_target: int = 400,
             withdraw_target: int = 200) -> dict:
    rng = random.Random(seed)
    cases: list[dict] = []

    deposit_count = 0
    attempts = 0
    while deposit_count < deposit_target and attempts < deposit_target * 200:
        attempts += 1
        nlev = rng.randint(1, 3)
        levels = _random_ladder(rng, nlev)
        side = rng.choice(["sellBase", "buyBase"])
        fee_bps = rng.choice([0, 1, 5, 10, 30, 50, 100])
        capacity = _internal_capacity(levels, side)
        if capacity <= 1:
            continue
        amount_in = rng.randint(1, max(1, capacity))
        base_net = rng.randint(10**6, 10**12)
        quote_net = rng.randint(10**6, 10**12)
        total_shares = rng.randint(10**6, 10**12)
        try:
            plan = solve_deposit_single(
                levels, side, amount_in, base_net, quote_net, total_shares, fee_bps
            )
        except (FixedPointError, ValueError):
            continue
        # Only emit plans the instruction would actually accept.
        if plan.shares == 0 or plan.swap_out == 0 or plan.db == 0 or plan.dq == 0:
            continue
        fields: dict[str, int | str] = {"kind": "deposit", "side": side, "nlev": nlev}
        for i, level in enumerate(levels):
            fields[f"lo{i}"] = level.sqrt_lo
            fields[f"hi{i}"] = level.sqrt_hi
            fields[f"liq{i}"] = level.liquidity
        fields.update({
            "fee_bps": fee_bps,
            "amount_in": amount_in,
            "base_net": base_net,
            "quote_net": quote_net,
            "total_shares": total_shares,
            "s": plan.s,
            "fee": plan.fee,
            "swap_out": plan.swap_out,
            "db": plan.db,
            "dq": plan.dq,
            "shares": plan.shares,
            "diff": plan.diff,
        })
        cases.append(fields)
        deposit_count += 1

    withdraw_count = 0
    attempts = 0
    while withdraw_count < withdraw_target and attempts < withdraw_target * 400:
        attempts += 1
        nlev = rng.randint(1, 3)
        levels = _random_ladder(rng, nlev)
        side = rng.choice(["sellBase", "buyBase"])
        fee_bps = rng.choice([0, 1, 5, 10, 30, 50, 100])
        # Keep the pro-rata leg within the ladder's conversion capacity.
        base_cap = max(1, _internal_capacity(levels, "sellBase"))
        quote_cap = max(1, _internal_capacity(levels, "buyBase"))
        base_net = rng.randint(1, base_cap)
        quote_net = rng.randint(1, quote_cap)
        total_shares = rng.randint(1, 10**9)
        shares = rng.randint(1, total_shares)
        try:
            plan = withdraw_single(
                levels, side, shares, base_net, quote_net, total_shares, fee_bps
            )
        except (FixedPointError, ValueError):
            continue
        if plan.converted == 0 or plan.swap_net == 0:
            continue
        fields = {"kind": "withdraw", "side": side, "nlev": nlev}
        for i, level in enumerate(levels):
            fields[f"lo{i}"] = level.sqrt_lo
            fields[f"hi{i}"] = level.sqrt_hi
            fields[f"liq{i}"] = level.liquidity
        fields.update({
            "fee_bps": fee_bps,
            "shares": shares,
            "total_shares": total_shares,
            "base_net": base_net,
            "quote_net": quote_net,
            "base_out": plan.base_out,
            "quote_out": plan.quote_out,
            "unwanted": plan.unwanted,
            "fee": plan.fee,
            "net": plan.swap_net,
            "converted": plan.converted,
            "payout": plan.payout,
        })
        cases.append(fields)
        withdraw_count += 1

    return {
        "version": 1,
        "seed": seed,
        "deposit": deposit_count,
        "withdraw": withdraw_count,
        "cases": cases,
    }


def _encode(case: dict) -> str:
    kind = case["kind"]
    fields = "|".join(
        f"{key}={value}" for key, value in case.items() if key != "kind"
    )
    return f"{kind}|{fields}"


def main() -> None:
    payload = generate()
    output = DEFAULT_OUTPUT
    output.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# version={payload['version']} seed={payload['seed']} "
        f"deposit={payload['deposit']} withdraw={payload['withdraw']} "
        f"cases={len(payload['cases'])}\n"
    )
    body = "\n".join(_encode(case) for case in payload["cases"]) + "\n"
    output.write_text(header + body)
    print(
        f"wrote {len(payload['cases'])} cases "
        f"({payload['deposit']} deposit, {payload['withdraw']} withdraw) to {output}"
    )


if __name__ == "__main__":
    main()
