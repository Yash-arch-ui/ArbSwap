"""S2.3 regression: the sizing tool's price normalization and capacity units must
match the corrected Rust keeper for a 9-decimal base / 6-decimal quote pool."""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

Q64 = 1 << 64
BPS = 10_000
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from pool_sizing import compute_sizing, normalize_price_q64  # noqa: E402


def _rust_anchor(price_q64: int, base: int, quote: int, bd: int, qd: int) -> int:
    out = subprocess.run(
        ["cargo", "run", "-q", "-p", "arbswap-keeper", "--", "single",
         str(price_q64), str(base), str(quote), "0", str(bd), str(qd)],
        cwd=ROOT, check=True, text=True, capture_output=True,
    ).stdout
    first = out.strip().splitlines()[0]
    return int(dict(part.split("=") for part in first.split(","))["anchor"])


def test_normalize_matches_rust_anchor():
    """The sizing tool's normalized ladder price matches the keeper's anchor."""
    price_q64 = 150 * Q64
    for bd, qd in ((9, 6), (6, 6), (6, 9)):
        raw = normalize_price_q64(price_q64, bd, qd)
        assert math.isqrt(raw << 64) == _rust_anchor(price_q64, 1_000, 150_000, bd, qd)


def test_level1_human_price_uses_raw_units():
    """9/6: level-1 human quote/base ratio is the USD price, not 1000x it."""
    s = compute_sizing(price=150.0, base_tokens=1000.0, depth_bps=10_000)
    l1 = s["l1_ask_base"], s["l1_ask_quote"]
    human_ratio = (l1[1] / 1e6) / (l1[0] / 1e9)
    assert abs(human_ratio - 150.0) <= 0.02 * 150.0, human_ratio

    # The legacy (pre-fix) ladder sits at the human price, so its ratio is 10^3.
    legacy = compute_sizing(price=150.0, base_tokens=1000.0, depth_bps=10_000,
                            legacy_usd_ladder=True)
    legacy_ratio = (legacy["l1_ask_quote"] / 1e6) / (legacy["l1_ask_base"] / 1e9)
    assert abs(legacy_ratio - 150_000.0) <= 0.02 * 150_000.0, legacy_ratio


def test_demo_fits_half_of_level1():
    """10 tSOL on a 2,000 tSOL pool stays under half of level-1 capacity."""
    s = compute_sizing(price=109.25290338, base_tokens=2000.0, depth_bps=10_000)
    assert s["demo_base"] <= s["l1_ask_base"] // 2
    assert s["l1_ask_base"] > 0 and s["l1_ask_quote"] > 0
