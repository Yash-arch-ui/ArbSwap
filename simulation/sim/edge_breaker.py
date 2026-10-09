"""S3.2: honest-replay trip rate for the realized-edge breaker.

Runs the ArbSwap vault (with the S3.2 edge tracker) on the pre-registered
one-hour slices of the real windows, with optional injected jumps and oracle
latency, and reports how often an HONEST keeper trips the breaker.

    python -m simulation.sim.edge_breaker
"""

from __future__ import annotations

from dataclasses import replace

from simulation.reference.quote_math import QuoteParams
from simulation.sim.costs import CostModel
from simulation.sim.engine import simulate
from simulation.sim.experiments import venue_set
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.flow_config import NOISE_ARRIVAL_RATE, NOISE_MEAN_SIZE
from simulation.sim.oracle import OracleModel
from simulation.sim.study import WINDOWS_BY_LABEL, _load_slice
from simulation.sim.windows import WINDOWS

LABELS = {w.label: w for w in WINDOWS}
REGIMES = {"W2": "mid-vol up", "W3": "crash", "W4": "trend", "W5": "high-vol up", "W6": "calm"}


def _inject_jumps(points, jump_bps: float, at_second: int):
    if jump_bps == 0:
        return points
    out = []
    for i, point in enumerate(points):
        factor = 1.0 + (jump_bps / 10_000.0 if i >= at_second else 0.0)
        out.append(replace(point, price=point.price * factor))
    return out


def run(label: str, *, latency: float = 1.0, jump_bps: float = 0.0,
        window_seconds: float = 3_600.0, max_edge_loss_bps: float = 500.0,
        step_seconds: float = 1.0):
    points = _load_slice(WINDOWS_BY_LABEL[label])
    points = _inject_jumps(points, jump_bps, len(points) // 2)
    venues = venue_set(QuoteParams(), start_price=points[0].price)
    venue = venues["ArbSwap"]
    venue.edge_window_seconds = window_seconds
    venue.max_edge_loss_bps = max_edge_loss_bps
    oracle = OracleModel(latency_seconds=latency)
    noise = NoiseFlow(seed=20261006, arrival_rate=NOISE_ARRIVAL_RATE, mean_size=NOISE_MEAN_SIZE)
    result = simulate(
        venue_name="ArbSwap",
        venue=venue,
        prices=points,
        oracle=oracle,
        noise=noise,
        informed=InformedFlow(),
        costs=CostModel(),
        step_seconds=step_seconds,
    )
    return {
        "label": label,
        "regime": REGIMES.get(label, label),
        "latency": latency,
        "jump_bps": jump_bps,
        "trips": venue.edge_trips,
        "edge_min": venue.edge_min,
        "trades": len(result.trades),
    }


def main() -> None:
    rows = []
    for label in ("W2", "W3", "W4", "W5", "W6"):
        rows.append(run(label, latency=1.0))
    for jump in (50.0, 100.0, 300.0):
        rows.append(run("W4", latency=1.0, jump_bps=jump))
    for latency in (0.2, 4.0):
        rows.append(run("W4", latency=latency))
    print("label,regime,latency,jump_bps,trips,edge_min,trades")
    for row in rows:
        print(
            f"{row['label']},{row['regime']},{row['latency']},{row['jump_bps']:.0f},"
            f"{row['trips']},{row['edge_min']:.1f},{row['trades']}"
        )


if __name__ == "__main__":
    main()
