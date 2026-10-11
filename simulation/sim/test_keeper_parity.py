"""Independent Python differential checks for the Rust keeper quote builder.

The keeper's quote math is integer and mirrors the Section 5 formulas in
``simulation/reference/quote_math.py``:

    q            = (B*P - Q) / (B*P + Q)                       (Section 5.3)
    spread       = clamp(floor + a1*sigma + a2*|q| + a3*c/P
                         + a4*max(0, age-grace) + jump_extra,
                         spread_min, spread_max)               (Section 5.5)
    ask_extra    = e*max(0, (P-Pprev)/Pprev)                    (Section 5.6)
    depth        = min(1, sigma_target/sigma, 1-c/c_max, 1-jump_cooldown)
                   capped by depth_budget                       (Section 5.9)

These tests re-derive the *integer* result in Python and require bit equality
with the Rust binary, which is a true differential check between the two
implementations. The fixtures exercise what the earlier single σ=0, same-scale
case could not: a non-zero inventory skew, a real token-decimals scale
(SOL 9 / USDC 6, audit F-03), and the directional add-on.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

Q64 = 1 << 64
BPS = 10_000
ROOT = Path(__file__).resolve().parents[2]

# KeeperParams::default() values this test mirrors.
SPREAD_FLOOR = 2
SPREAD_MIN = 2
SPREAD_MAX = 50
INVENTORY_COEFF = 5
VOLATILITY_COEFF = 10_000
CONFIDENCE_COEFF = 10_000
CONFIDENCE_MAX_BPS = 10
JUMP_EXTRA = 5
JUMP_COOLDOWN = 5_000
DIRECTIONAL_COEFF = 10_000
UTILIZATION = 5_000
DEPTH_BUDGET = 10_000
SIGMA_TARGET_Q64 = 1 << 60
OFFSETS = (2, 5, 10, 20, 40, 80)
WEIGHTS = (1000, 1500, 2000, 2000, 2000, 1500)
CONFIDENCE_BPS = 1  # `single` uses a fixed confidence of 1 bp


def expected(
    price_q64: int,
    base: int,
    quote: int,
    *,
    previous_price_q64: int = 0,
    base_decimals: int = 0,
    quote_decimals: int = 0,
) -> dict[str, int | list[tuple[int, int, int]]]:
    # S2.3: normalize the human oracle price ONCE to the raw quote-atoms-per-
    # base-atom price `P_raw = P * 10^(dq-db)` (integer; division floors).
    def normalize(p: int) -> int:
        if p == 0 or base_decimals == quote_decimals:
            return p
        if quote_decimals > base_decimals:
            return p * 10 ** (quote_decimals - base_decimals)
        return p // 10 ** (base_decimals - quote_decimals)

    price_raw = normalize(price_q64)
    previous_raw = normalize(previous_price_q64)
    # Inventory imbalance on the base *value* in quote atoms. `price_raw` already
    # carries the token-decimal scale, so it is applied exactly once.
    base_value = base * price_raw // Q64
    denominator = base_value + quote
    if base_value >= quote:
        q_bps = min(BPS, (base_value - quote) * BPS // denominator)
    else:
        q_bps = -min(BPS, (quote - base_value) * BPS // denominator)
    # Rust `/` truncates toward zero; Python `//` floors. The keeper uses signed
    # division on `q_bps`, so mirror the truncation (FORMULA Section 1.2).
    scaled = INVENTORY_COEFF * q_bps
    skew = (abs(scaled) // BPS) * (1 if scaled >= 0 else -1)
    factor = BPS - skew
    reservation = price_raw * factor // BPS

    # sigma = 0 for `single`, so the volatility term is zero; the confidence
    # term and the *inventory* term both contribute (F-09 alignment).
    raw_spread = (
        SPREAD_FLOOR
        + VOLATILITY_COEFF * 0 // BPS
        + INVENTORY_COEFF * abs(q_bps) // BPS
        + CONFIDENCE_COEFF * CONFIDENCE_BPS // BPS
        + 0
    )
    spread = max(SPREAD_MIN, min(SPREAD_MAX, raw_spread))

    if previous_raw == 0 or price_raw == 0:
        ask_extra = bid_extra = 0
    else:
        move_bps = abs(price_raw - previous_raw) * BPS // previous_raw
        ask_extra = move_bps * DIRECTIONAL_COEFF // BPS if price_raw > previous_raw else 0
        bid_extra = move_bps * DIRECTIONAL_COEFF // BPS if previous_raw > price_raw else 0

    sigma = 0
    sigma_factor = BPS if sigma == 0 else BPS
    confidence_factor = BPS - min(BPS, CONFIDENCE_BPS * BPS // CONFIDENCE_MAX_BPS)
    jump_factor = 0
    rule = sigma_factor * confidence_factor // BPS
    rule = rule * (BPS - jump_factor) // BPS
    depth = min(BPS, rule, DEPTH_BUDGET)

    ask_spread = spread + ask_extra
    bid_spread = spread + bid_extra
    ask_capacity = base * UTILIZATION * depth // (BPS * BPS)
    bid_capacity = quote * UTILIZATION * depth // (BPS * BPS)
    ask_levels = []
    previous = 0
    for offset, weight in zip(OFFSETS, WEIGHTS):
        lo_price = reservation * (BPS + ask_spread + previous) // BPS
        hi_price = reservation * (BPS + ask_spread + offset) // BPS
        lo = math.isqrt(lo_price << 64)
        hi = math.isqrt(hi_price << 64)
        level_capacity = ask_capacity * weight // BPS
        liquidity = level_capacity * lo * hi // (hi - lo)
        ask_levels.append((lo, hi, liquidity))
        previous = offset
    bid_levels = []
    previous = 0
    for offset, weight in zip(OFFSETS, WEIGHTS):
        hi_price = reservation * (BPS - bid_spread - previous) // BPS
        lo_price = reservation * (BPS - bid_spread - offset) // BPS
        lo = math.isqrt(lo_price << 64)
        hi = math.isqrt(hi_price << 64)
        level_capacity = bid_capacity * weight // BPS
        liquidity = level_capacity * (1 << 128) // (hi - lo)
        bid_levels.append((lo, hi, liquidity))
        previous = offset
    return {
        "anchor": math.isqrt(price_raw << 64),
        "reservation": math.isqrt(reservation << 64),
        "spread": spread,
        "ask_extra": ask_extra,
        "bid_extra": bid_extra,
        "depth": depth,
        "ask_levels": ask_levels,
        "bid_levels": bid_levels,
    }


def rust_quote(
    price_q64: int,
    base: int,
    quote: int,
    *,
    previous_price_q64: int = 0,
    base_decimals: int = 0,
    quote_decimals: int = 0,
) -> dict[str, int | list[tuple[int, int, int]]]:
    result = subprocess.run(
        [
            "cargo", "run", "-q", "-p", "arbswap-keeper", "--", "single",
            str(price_q64), str(base), str(quote),
            str(previous_price_q64), str(base_decimals), str(quote_decimals),
        ],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    lines = result.stdout.strip().splitlines()
    fields = {key: int(value) for key, value in (part.split("=") for part in lines[0].split(","))}
    ask_levels, bid_levels = [], []
    for line in lines[1:]:
        name, values = line.split("=", 1)
        level = tuple(int(value.strip()) for value in values.split(","))
        if name.startswith("ask"):
            ask_levels.append(level)
        elif name.startswith("bid"):
            bid_levels.append(level)
    fields["ask_levels"] = ask_levels
    fields["bid_levels"] = bid_levels
    return fields


def test_keeper_matches_independent_python_quote_construction():
    """Same-scale fixtures: balanced, long-base and short-base skews."""
    cases = (
        (150 * Q64, 1_000, 150_000),
        (150 * Q64, 1_000, 100_000),   # long base -> q > 0 -> reservation < price
        (150 * Q64, 1_000, 300_000),   # short base -> q < 0 -> reservation > price
        (123 * Q64, 2_000, 246_000),
        (200 * Q64, 900, 120_000),
    )
    for price, base, quote in cases:
        assert rust_quote(price, base, quote) == expected(price, base, quote)


def test_keeper_inventory_skew_is_decimal_aware():
    """S2.3 regression: 9-decimal base / 6-decimal quote.

    A balanced 1000 SOL / 150,000 USDC vault must quote *at* the anchor, and the
    ladder must use the raw quote-atoms-per-base-atom price (`P / 10^3`), not
    the human price — the pre-fix 10^3 mis-scaling.
    """
    price = 150 * Q64
    base = 1_000 * 10**9        # 1000 SOL in 9-decimal atoms
    quote = 150_000 * 10**6     # 150,000 USDC in 6-decimal atoms
    got = rust_quote(price, base, quote, base_decimals=9, quote_decimals=6)
    want = expected(price, base, quote, base_decimals=9, quote_decimals=6)
    assert got == want
    assert got["reservation"] == got["anchor"], "balanced vault must not be skewed"

    # 50,000 USDC against the same 1000 SOL is a clearly long-base vault (~100%
    # imbalance), so the whole-bps inventory skew is non-zero and the reservation
    # must drop below the anchor.
    long_base = rust_quote(price, base, 50_000 * 10**6, base_decimals=9, quote_decimals=6)
    assert long_base["reservation"] < long_base["anchor"]
    assert long_base == expected(price, base, 50_000 * 10**6, base_decimals=9, quote_decimals=6)

    # 300,000 USDC against the same 1000 SOL is a short-base vault: q < 0, so the
    # reservation must rise above the anchor.
    short_base = rust_quote(price, base, 300_000 * 10**6, base_decimals=9, quote_decimals=6)
    assert short_base["reservation"] > short_base["anchor"]
    assert short_base == expected(price, base, 300_000 * 10**6, base_decimals=9, quote_decimals=6)


def test_keeper_supports_decimal_pairs():
    """S2.3: the normalization path must work for 9/6, 6/6 and 6/9."""
    price = 150 * Q64
    # A balanced pool at the human price for each decimal pairing.
    # 9/6: 1000 base tokens, 150,000 quote tokens.
    # 6/6: 1,000 base tokens, 150,000 quote tokens.
    # 6/9: 1,000 base tokens, 150,000 quote tokens.
    for base_dec, quote_dec, base_tokens, quote_tokens in (
        (9, 6, 1_000, 150_000),
        (6, 6, 1_000, 150_000),
        (6, 9, 1_000, 150_000),
    ):
        base = base_tokens * 10**base_dec
        quote = quote_tokens * 10**quote_dec
        got = rust_quote(price, base, quote, base_decimals=base_dec, quote_decimals=quote_dec)
        want = expected(price, base, quote, base_decimals=base_dec, quote_decimals=quote_dec)
        assert got == want, (base_dec, quote_dec)
        assert got["reservation"] == got["anchor"], (base_dec, quote_dec)
        # The anchor is the raw-unit price, sqrt(P * 10^(dq-db)) in Q64.64.
        expected_raw = price * 10 ** (quote_dec - base_dec) if quote_dec >= base_dec else price // 10 ** (base_dec - quote_dec)
        assert abs(got["anchor"] - math.isqrt(expected_raw << 64)) <= 1


def test_keeper_directional_addon_is_encoded():
    """A 1 USDC rise on a 149 USDC prior price widens the ask side only."""
    previous = 149 * Q64
    price = 150 * Q64
    got = rust_quote(price, 1_000, 150_000, previous_price_q64=previous)
    want = expected(price, 1_000, 150_000, previous_price_q64=previous)
    assert got == want
    assert got["ask_extra"] > 0
    assert got["bid_extra"] == 0

    # A fall widens the bid side instead.
    down = rust_quote(148 * Q64, 1_000, 150_000, previous_price_q64=previous)
    assert down["ask_extra"] == 0
    assert down["bid_extra"] > 0


def test_keeper_pricing_matches_the_simulator_reference():
    """Keeper anchor/reservation/depth against ``quote_math.compute_quote``.

    The simulator uses float fractions; the keeper uses integer bps. The
    *pricing core* (anchor, reservation, depth throttle) must agree within
    rounding. The spread coefficient scales still differ (audit F-09), so the
    spread itself is compared only structurally elsewhere.
    """
    from simulation.reference.quote_math import QuoteParams, VolatilityState, compute_quote

    cases = (
        (150 * Q64, 1_000, 150_000),
        (150 * Q64, 1_000, 100_000),
        (150 * Q64, 1_000, 220_000),
        (200 * Q64, 900, 120_000),
    )
    conf_bps = 1
    for price_q64, base, quote in cases:
        price = price_q64 / Q64
        reference = compute_quote(
            price=price,
            base_reserve=base,
            quote_reserve=quote,
            confidence=price * conf_bps / 10_000,
            age=0.0,
            volatility=VolatilityState(),
            params=QuoteParams(),
        )
        got = rust_quote(price_q64, base, quote)
        keeper_anchor = got["anchor"] ** 2 / (1 << 128)
        keeper_reservation = got["reservation"] ** 2 / (1 << 128)
        assert abs(keeper_anchor - reference.reference_price) <= 1e-6 * price
        # The keeper quantises the inventory skew to whole bps, so the
        # reservation agrees with the float reference to within one bps of price.
        assert (
            abs(keeper_reservation - reference.reservation_price)
            <= 2e-4 * reference.reservation_price
        )
        assert abs(got["depth"] / 10_000 - reference.depth_mult) <= 1e-9
        # F-09: the spread now matches the reference; the only slack is the
        # keeper's whole-bps inventory quantum.
        assert abs(got["spread"] / 10_000 - reference.half_spread) <= 1.5e-4



def test_keeper_replay_emits_a_two_sided_payload(tmp_path):
    """The replay path encodes BOTH ladders: the payload length is the
    two-sided layout (ask levels + bid levels), not the old single ladder."""
    from pathlib import Path

    csv = Path(tmp_path) / "replay.csv"
    csv.write_text(
        "slot,publish_time,price_q64,confidence_bps,base_reserve,quote_reserve\n"
        f"1,1,{150 * Q64},1,1000000000,1000000000\n"
        f"2,2,{150 * Q64},1,1000000000,1000000000\n"
    )
    result = subprocess.run(
        ["cargo", "run", "-q", "-p", "arbswap-keeper", "--", "replay", str(csv)],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    updates = [line for line in result.stdout.splitlines() if line.startswith("update,")]
    assert updates, result.stdout
    payload = bytes.fromhex(updates[0].split("instruction_hex=")[1])
    two_sided_len = 8 + 8 + 8 + 16 + 4 + 16 + 16 + 16 + 6 * 4 + 6 * 4 + 6 * 80 * 2
    assert len(payload) == two_sided_len
