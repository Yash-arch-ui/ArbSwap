"""T6.1 — one-command headline chart reproduction (Build Plan §12 P6).

Reproduces the headline chart from ``docs/HEADLINE.md``: the routed-venue
comparison (volume share, fill share, 2s markout) across the pre-registered
W1-W6 one-hour slices, computed by ``simulation.sim.router.route_window``.

If the gitignored raw W1-W6 archives are present they are used (a real price
path); otherwise a deterministic synthetic price path is generated so the
command always succeeds for a stranger with no data. The chart is a
dependency-free SVG (the §9.2 ``charts.py`` style); the numbers are also written
as JSON. Flow is always synthetic, so every number is a **model output**, not a
product result.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from simulation.analytics.charts import bar_svg
from simulation.sim.price_source import PricePoint
from simulation.sim.router import route_window
from simulation.sim.study import SOL_USDT_CSV, USDC_USDT_CSV, _load_slice
from simulation.sim.windows import WINDOWS

ROOT = Path(__file__).resolve().parents[2]
OUT_SVG = ROOT / "docs" / "headline_chart.svg"
OUT_JSON = ROOT / "simulation" / "data" / "results" / "headline.json"

SECONDS = 3_600
VENUE_ORDER = {"ArbSwap": 0, "B1_passive": 1, "PropAMM": 2}


def synthetic_slice(seed: int, start_price: float = 110.0) -> list[PricePoint]:
    """Deterministic geometric-random-walk fallback (no raw data required)."""
    rng = random.Random(seed)
    price = start_price
    sigma = 0.0009
    out: list[PricePoint] = []
    for second in range(SECONDS):
        price *= 1.0 + rng.gauss(0.0, sigma)
        out.append(PricePoint(second=second, price=price))
    return out


def load_or_synthetic(window) -> tuple[list[PricePoint], str]:
    """Return the window slice and its source (``real`` or ``synthetic``)."""
    try:
        if SOL_USDT_CSV.exists() and USDC_USDT_CSV.exists():
            return _load_slice(window), "real"
    except (FileNotFoundError, OSError, ValueError):
        pass
    return synthetic_slice(seed=abs(hash(window.label)) % 65_536), "synthetic"


def aggregate() -> tuple[list[dict], str]:
    """Mean per-venue metrics over W1-W6 (W1 is the calibration window)."""
    totals: dict[str, dict] = {}
    source = "real"
    for window in WINDOWS:
        prices, src = load_or_synthetic(window)
        if src == "synthetic":
            source = "synthetic"
        for row in route_window(prices):
            t = totals.setdefault(
                row["venue"],
                {"volume_share": 0.0, "fill_share": 0.0, "markout_2s_bps": 0.0, "n": 0},
            )
            t["volume_share"] += row["volume_share"]
            t["fill_share"] += row["fill_share"]
            t["markout_2s_bps"] += row["markout_2s_bps"]
            t["n"] += 1
    rows = []
    for venue, t in totals.items():
        n = t["n"] or 1
        rows.append(
            {
                "venue": venue,
                "volume_share": t["volume_share"] / n,
                "fill_share": t["fill_share"] / n,
                "markout_2s_bps": t["markout_2s_bps"] / n,
            }
        )
    rows.sort(key=lambda r: VENUE_ORDER.get(r["venue"], 9))
    return rows, source


def render(rows: list[dict], source: str) -> str:
    """A single self-contained SVG with the three headline panels."""
    labels = [r["venue"] for r in rows]
    volume = bar_svg(labels, [100.0 * r["volume_share"] for r in rows],
                     title="Volume share (%) - W1-W6 mean")
    fills = bar_svg(labels, [100.0 * r["fill_share"] for r in rows],
                    title="Fill share (%) - W1-W6 mean")
    markout = bar_svg(labels, [r["markout_2s_bps"] for r in rows],
                      title="2s markout (bps) - W1-W6 mean")
    note = (f"price path: {source}; flow is synthetic (model output, not a "
            "product result). See docs/HEADLINE.md.")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 650" '
        'width="600" height="650">'
        '<rect width="600" height="650" fill="#ffffff"/>'
        '<text x="8" y="20" font-size="15" fill="#111">'
        'ArbSwap headline - routed-venue comparison</text>'
        f'<text x="8" y="38" font-size="10" fill="#6b7280">{note}</text>'
        f'<g transform="translate(20,56)">{volume}</g>'
        f'<g transform="translate(20,222)">{fills}</g>'
        f'<g transform="translate(20,388)">{markout}</g>'
        "</svg>\n"
    )


def main() -> None:
    rows, source = aggregate()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({"source": source, "rows": rows}, indent=2) + "\n")
    OUT_SVG.write_text(render(rows, source))
    print(f"wrote {OUT_SVG.relative_to(ROOT)}")
    print(f"wrote {OUT_JSON.relative_to(ROOT)}")
    for r in rows:
        print(f"  {r['venue']:11} vol={r['volume_share']:6.1%} "
              f"fill={r['fill_share']:6.1%} mkt={r['markout_2s_bps']:+7.3f}bps")
    print(f"  price path: {source}; flow synthetic (model output)")


if __name__ == "__main__":
    main()
