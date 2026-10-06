"""Golden vector generator (T1.2).

Generates ``>= 500`` deterministic cases covering the fixed-point primitives,
the Q64.64 ladder walk, and the vault share math. The Rust crate is checked
against this file (``crates/arb-math/tests/golden.rs``).

Usage (testing phase):

    python -m research.reference.golden

The output path defaults to ``crates/arb-math/tests/golden_vectors.txt``.
Each line is ``kind|field=value|...`` with decimal-integer values only, so the
Rust test parses it without a JSON dependency.
"""

from __future__ import annotations

import random
from pathlib import Path

from research.reference.fixed import (
    ceil_bps,
    div_q64,
    mul_bps,
    mul_q64,
    one_plus_q64,
    price_from_sqrt,
    recip_q64,
    sqrt_price_scaled,
    sqrt_q64,
    tdiv,
    FixedPointError,
)
from research.reference.ladder import (
    Level,
    deposit_shares,
    fee_amount,
    first_deposit_shares,
    walk_ladder,
    withdrawal_amounts,
)

Q64 = 1 << 64
DEFAULT_OUTPUT = Path("crates/arb-math/tests/golden_vectors.txt")


def _rand_q64_price(rng: random.Random) -> int:
    """A plausible Q64.64 sqrt price for a $20-$400 asset."""
    price = rng.uniform(20.0, 400.0)
    # Integer sqrt of price * 2^64, computed exactly.
    return sqrt_q64(int(price * Q64))


def _level_and_inputs(rng: random.Random) -> tuple[Level, int, int]:
    lo = _rand_q64_price(rng)
    hi = lo + rng.randint(Q64 // 100, Q64)  # 1% to 100% width
    liquidity = rng.randint(10**18, 10**24)
    level = Level(lo, hi, liquidity)
    ask_amount = rng.randint(0, level.quote_capacity())
    bid_amount = rng.randint(0, level.base_capacity())
    return level, ask_amount, bid_amount


def generate(seed: int = 20261006, target: int = 520) -> dict:
    rng = random.Random(seed)
    cases: list[dict] = []

    def add(kind: str, **fields: int) -> None:
        cases.append({"kind": kind, **{k: str(v) for k, v in fields.items()}})

    def try_add(kind: str, **fields: int) -> None:
        """Add a vector only when the reference accepts the input domain."""
        try:
            add(kind, **fields)
        except FixedPointError:
            pass

    # --- Fixed-point primitives -------------------------------------------
    for _ in range(120):
        a = rng.randint(0, (1 << 92))
        b = rng.randint(1, (1 << 92))
        try_add("mul_q64", a=a, b=b, expected=mul_q64(a, b))
        if a > 0:
            try_add("div_q64", a=a, b=b, expected=div_q64(a, b))
    for _ in range(60):
        v = rng.randint(0, (1 << 120))
        try_add("sqrt_q64", v=v, expected=sqrt_q64(v))
    for _ in range(40):
        s = rng.randint(2, (1 << 120))
        try_add("recip_q64", s=s, expected=recip_q64(s))
    for _ in range(40):
        a = rng.randint(0, (1 << 80))
        try_add("price_from_sqrt", a=a, expected=price_from_sqrt(a))
    for _ in range(40):
        x = rng.randint(-9_000, 9_000)
        try_add("one_plus_q64", x=x, expected=one_plus_q64(x))
    for _ in range(40):
        sqrt_p = _rand_q64_price(rng)
        x = rng.randint(-5_000, 5_000)
        try_add("sqrt_price_scaled", sqrt_p=sqrt_p, x=x,
                expected=sqrt_price_scaled(sqrt_p, x))
    for _ in range(40):
        x = rng.randint(0, (1 << 120))
        bps = rng.randint(0, 10_000)
        try_add("mul_bps", x=x, bps=bps, expected=mul_bps(x, bps))
        try_add("ceil_bps", x=x, bps=bps, expected=ceil_bps(x, bps))
    for _ in range(30):
        a = rng.randint(-(1 << 90), (1 << 90))
        b = rng.randint(1, (1 << 90))
        try_add("tdiv", a=a, b=b, expected=tdiv(a, b))

    # --- Ladder walk ------------------------------------------------------
    for _ in range(120):
        level, ask_amount, bid_amount = _level_and_inputs(rng)
        ask = walk_ladder([level], "ask", ask_amount)
        bid = walk_ladder([level], "bid", bid_amount)
        add("walk_ask", lo=level.sqrt_lo, hi=level.sqrt_hi,
            liquidity=level.liquidity, amount=ask_amount,
            expected=ask.out, consumed=ask.consumed, remaining=ask.remaining)
        add("walk_bid", lo=level.sqrt_lo, hi=level.sqrt_hi,
            liquidity=level.liquidity, amount=bid_amount,
            expected=bid.out, consumed=bid.consumed, remaining=bid.remaining)

    # --- Vault math -------------------------------------------------------
    for _ in range(40):
        db = rng.randint(1, 10**15)
        dq = rng.randint(1, 10**18)
        min_liq = rng.randint(0, 10**6)
        try:
            add("first_deposit", db=db, dq=dq, min=min_liq,
                expected=first_deposit_shares(db, dq, min_liq))
        except Exception:
            continue
    for _ in range(40):
        db = rng.randint(1, 10**15)
        dq = rng.randint(1, 10**18)
        rb = rng.randint(1, 10**18)
        rq = rng.randint(1, 10**21)
        shares = rng.randint(1, 10**18)
        add("deposit_shares", db=db, dq=dq, rb=rb, rq=rq, shares=shares,
            expected=deposit_shares(db, dq, rb, rq, shares))
    for _ in range(40):
        shares = rng.randint(0, 10**18)
        rb = rng.randint(1, 10**18)
        rq = rng.randint(1, 10**21)
        total = rng.randint(shares + 1, shares + 10**18)
        out_b, out_q = withdrawal_amounts(shares, rb, rq, total)
        add("withdrawal", shares=shares, rb=rb, rq=rq, total=total,
            expected_b=out_b, expected_q=out_q)
    for _ in range(40):
        amount = rng.randint(0, (1 << 120))
        fee_bps = rng.randint(0, 100)
        add("fee", amount=amount, fee_bps=fee_bps,
            expected=fee_amount(amount, fee_bps))

    return {"version": 1, "seed": seed, "target": target, "cases": cases}


def _encode(case: dict) -> str:
    kind = case["kind"]
    fields = "|".join(f"{key}={value}" for key, value in case.items() if key != "kind")
    return f"{kind}|{fields}"


def main() -> None:
    payload = generate()
    output = DEFAULT_OUTPUT
    output.parent.mkdir(parents=True, exist_ok=True)
    header = f"# version={payload['version']} seed={payload['seed']} cases={len(payload['cases'])}\n"
    body = "\n".join(_encode(case) for case in payload["cases"]) + "\n"
    output.write_text(header + body)
    print(f"wrote {len(payload['cases'])} cases to {output}")


if __name__ == "__main__":
    main()
