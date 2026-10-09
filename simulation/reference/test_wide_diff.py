"""Differential fuzz of arb-math wide/Q64 primitives vs Python big integers.

Drives `vault/math/examples/wide_probe` (which reads ops on stdin) and compares
every result to `int` arithmetic. Set ``WIDE_DIFF_CASES`` to raise the per-op
count (default 2_000 for CI; the local full run uses 1_000_000). Cases are
streamed one operation at a time so memory stays bounded.
"""

from __future__ import annotations

import math
import os
import random
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = int(os.environ.get("WIDE_DIFF_CASES", "2000"))
U256_MASK = (1 << 256) - 1
U128_MAX = (1 << 128) - 1


def _hex(n: int) -> str:
    return format(n, "x")


def _run(lines: list[str]) -> list[str]:
    payload = "\n".join(lines) + "\n"
    result = subprocess.run(
        ["cargo", "run", "-q", "--example", "wide_probe", "-p", "arb-math"],
        cwd=ROOT, input=payload, text=True, capture_output=True, check=True,
    )
    return result.stdout.strip("\n").split("\n")


def _norm(text: str) -> str:
    return " ".join(format(int(part, 16), "x") for part in text.split())


def _check(lines: list[str], expected: list[str], op: str) -> None:
    got = _run(lines)
    assert len(got) == len(lines), f"{op}: expected {len(lines)} results, got {len(got)}"
    mismatches = [
        (line, exp, act)
        for line, exp, act in zip(lines, expected, got)
        if _norm(act) != _norm(exp)
    ]
    assert not mismatches, f"{op}: {len(mismatches)} mismatches, first 5: {mismatches[:5]}"


def test_wide_primitives_match_python():
    rng = random.Random(0xA5B5C5)

    # mul_u128 (full 256-bit product; a,b < 2^96 so (a*b)>>64 fits u128 elsewhere)
    lines, expected = [], []
    for _ in range(CASES):
        a, b = rng.getrandbits(96), rng.getrandbits(96)
        lines.append(f"mul_u128 {a} {b}")
        expected.append(_hex(a * b))
    _check(lines, expected, "mul_u128")

    # div_rem: random U256 dividend/divisor plus targeted edges.
    lines, expected = [], []
    for _ in range(CASES):
        a = rng.getrandbits(rng.choice([64, 128, 192, 256]))
        b = rng.getrandbits(rng.choice([64, 128, 129, 192, 193, 255, 256])) or 1
        lines.append(f"div_rem {_hex(a)} {_hex(b)}")
        expected.append(f"{_hex(a // b)} {_hex(a % b)}")
    for a, b in [
        (1, 1), (0, 1), (1 << 128, 1 << 128), ((1 << 128) + 1, (1 << 128) + 1),
        ((1 << 192) - 1, (1 << 192) - 1), ((1 << 128) + 7, (1 << 128) + 1),
        ((1 << 200) + 12345, (1 << 129) + 3), ((1 << 255) + 1, (1 << 254) + 1),
        (3, 1 << 128), ((1 << 256) - 1, (1 << 255)), ((1 << 256) - 1, (1 << 128) + 1),
        (123456789 * ((1 << 192) + 1), (1 << 192) + 1),
        ((1 << 256) - 1, (1 << 256) - 1), (1 << 255, (1 << 255)),
    ]:
        lines.append(f"div_rem {_hex(a)} {_hex(b)}")
        expected.append(f"{_hex(a // b)} {_hex(a % b)}")
    _check(lines, expected, "div_rem")

    # shl / shr
    lines, expected = [], []
    for _ in range(CASES):
        a = rng.getrandbits(256)
        n = rng.randrange(0, 256)
        lines.append(f"shl {_hex(a)} {n}")
        expected.append(_hex((a << n) & U256_MASK))
        lines.append(f"shr {_hex(a)} {n}")
        expected.append(_hex(a >> n))
    _check(lines, expected, "shl/shr")

    # isqrt
    lines, expected = [], []
    for _ in range(CASES):
        a = rng.getrandbits(rng.choice([64, 128, 192, 256]))
        lines.append(f"isqrt {_hex(a)}")
        expected.append(_hex(math.isqrt(a)))
    _check(lines, expected, "isqrt")

    # mul_q64 / div_q64 / recip_q64 / sqrt_q64 / price_from_sqrt
    lines, expected = [], []
    for _ in range(CASES):
        a, b = rng.getrandbits(96), rng.getrandbits(96)
        lines.append(f"mul_q64 {a} {b}")
        expected.append(_hex((a * b) >> 64))
        a, b = rng.getrandbits(64), (rng.getrandbits(64) or 1)
        exp = (a << 64) // b
        if exp <= U128_MAX:
            lines.append(f"div_q64 {a} {b}")
            expected.append(_hex(exp))
        a = rng.getrandbits(128) or 1
        exp = (1 << 128) // a
        if exp <= U128_MAX:
            lines.append(f"recip_q64 {a}")
            expected.append(_hex(exp))
        a = rng.getrandbits(128)
        lines.append(f"sqrt_q64 {a}")
        expected.append(_hex(math.isqrt(a << 64)))
        a = rng.getrandbits(96)
        lines.append(f"price_from_sqrt {a}")
        expected.append(_hex((a * a) >> 64))
    _check(lines, expected, "q64")
