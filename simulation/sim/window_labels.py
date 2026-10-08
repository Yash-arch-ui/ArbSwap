"""T4: label windows by MEASURED realized volatility and drift (not assumed
regime names), including the two pre-registered stress weeks S-A/S-B, and the
effect of injected jumps (50, 100, 300 bps)."""

from __future__ import annotations

import json
import math
from pathlib import Path

from simulation.sim.usdt_usdc import convert_legs
from simulation.sim.windows import WINDOWS, window_stats
from simulation.sim.price_source import load_price_window

RAW = Path("simulation/data/raw")
OUT = Path("simulation/data/results/window_labels.json")
JUMPS_BPS = (50, 100, 300)


def _sigma(prices: list[float]) -> float:
    total = 0.0
    for a, b in zip(prices, prices[1:]):
        if a > 0 and b > 0:
            total += math.log(b / a) ** 2
    return math.sqrt(total / (len(prices) - 1)) if len(prices) > 1 else 0.0


def _from_pair(sol_path: Path, usdc_path: Path, start_ms: int, end_ms: int) -> list[float]:
    sol = load_price_window(sol_path, start_ms=start_ms, end_ms=end_ms)
    usdc = load_price_window(usdc_path, start_ms=start_ms, end_ms=end_ms)
    return [p.price for p in convert_legs(sol, usdc)]


def label_windows() -> dict:
    rows = {}
    for w in WINDOWS:
        prices = _from_pair(RAW / "binance_SOLUSDT_1s_6w.csv",
                            RAW / "binance_USDCUSDT_1s_6w.csv", w.start_ms, w.end_ms)
        s = window_stats(w.label, prices)
        rows[w.label] = {"dates": w.dates, "sigma": s.sigma, "log_return": s.log_return}
    stress = {
        "S-A": ("2026-07-06", "2026-07-12", RAW / "binance_SOLUSDT_1s_SA.csv",
                RAW / "binance_USDCUSDT_1s_SA.csv"),
        "S-B": ("2026-07-13", "2026-07-19", RAW / "binance_SOLUSDT_1s_SB.csv",
                RAW / "binance_USDCUSDT_1s_SB.csv"),
    }
    from datetime import datetime, timezone
    for name, (a, b, sp, up) in stress.items():
        start = int(datetime.fromisoformat(a).replace(tzinfo=timezone.utc).timestamp() * 1000)
        end = int(datetime.fromisoformat(b).replace(tzinfo=timezone.utc).timestamp() * 1000) + 86_400_000
        prices = _from_pair(sp, up, start, end)
        s = window_stats(name, prices)
        rows[name] = {"dates": f"{a} .. {b}", "sigma": s.sigma, "log_return": s.log_return}
    return rows


def injected_jump_sigma(base_sigma: float, jump_bps: float, per_hour: int = 1) -> float:
    """Sigma after injecting `per_hour` jumps of `jump_bps` (one-sided) per hour."""
    return math.sqrt(base_sigma**2 + per_hour * (jump_bps / 10_000.0) ** 2 / 3600.0)


if __name__ == "__main__":
    rows = label_windows()
    # Label by measured volatility terciles + drift sign.
    ordered = sorted(rows.items(), key=lambda kv: kv[1]["sigma"])
    for rank, (name, r) in enumerate(ordered):
        vol = "low" if rank < len(ordered) / 3 else ("high" if rank >= 2 * len(ordered) / 3 else "mid")
        drift = "up" if r["log_return"] > 0.02 else ("down" if r["log_return"] < -0.02 else "flat")
        r["label"] = f"{vol}-vol {drift}"
        print(f"{name:4} {r['dates']:24} sigma={r['sigma']:.3e} ret={r['log_return']:+.4f} -> {r['label']}")
    print("injected jumps on W4 (base sigma %.3e):" % rows["W4"]["sigma"],
          {j: round(injected_jump_sigma(rows['W4']['sigma'], j), 6) for j in JUMPS_BPS})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")
