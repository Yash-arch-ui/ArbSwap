"""Analytics CLI (Build Plan §9).

    python -m simulation.analytics build [--scenario calm] [--length 3600] [--seed 20261006]
                              [--out analytics/out]

Runs the simulator for ArbSwap and the passive benchmark on one deterministic
scenario, bridges the trades to program events, indexes them, and writes:

    <out>/events.jsonl    the indexed event stream
    <out>/metrics.json    the computed metrics per venue
    <out>/dashboard.html  the static dashboard (LP / trader / risk / comparison)
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from simulation.analytics import dashboard
from simulation.analytics import events as ev
from simulation.analytics import indexer, metrics
from simulation.analytics.bridge import analytics_for, events_from_simulation


def build(out: Path, *, scenario: str, length: int, seed: int) -> dict:
    # Imported here so the metrics/events modules stay simulator-free.
    from simulation.sim.engine import simulate
    from simulation.sim.flow import InformedFlow, NoiseFlow
    from simulation.sim.oracle import OracleModel
    from simulation.sim.price_source import synthetic_series
    from simulation.sim.venues import PassivePool, VaultVenue

    points = synthetic_series(regime=scenario, length=length, seed=seed)
    price_path = [p.price for p in points]

    def price_at(second: int):
        return price_path[second] if 0 <= second < len(price_path) else None

    venues = {}
    total_events = []
    for name, venue in (("ArbSwap", VaultVenue()), ("B1_passive", PassivePool(fee=0.0001))):
        result = simulate(
            venue_name=name,
            venue=venue,
            prices=points,
            oracle=OracleModel(),
            noise=NoiseFlow(seed=seed),
            informed=InformedFlow(),
            step_seconds=1.0,
        )
        venues[name] = analytics_for(result, name, price_at)
        total_events.extend(events_from_simulation(result))

    store = indexer.index(total_events)
    out.mkdir(parents=True, exist_ok=True)
    ev.dump_jsonl(store.events, out / "events.jsonl")
    payload = {
        "scenario": scenario,
        "length": length,
        "seed": seed,
        "events": len(store.events),
        "swaps": len(store.swaps),
        "venues": {
            name: {
                **{k: v for k, v in asdict(v).items() if k != "gap"},
                "gap": asdict(v.gap),
            }
            for name, v in venues.items()
        },
    }
    (out / "metrics.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    html = dashboard.render(
        "ArbSwap analytics (replayed)",
        venues,
        risk=dashboard.RiskView(quote_version=store.version, last_slot=store.max_slot),
        scenario=scenario,
    )
    (out / "dashboard.html").write_text(html)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build", help="index a scenario and render the dashboard")
    build_parser.add_argument("--scenario", default="calm", choices=("calm", "trend", "crash"))
    build_parser.add_argument("--length", type=int, default=3_600)
    build_parser.add_argument("--seed", type=int, default=20261006)
    build_parser.add_argument("--out", type=Path, default=Path("simulation/analytics/out"))
    demo_parser = sub.add_parser("demo", help="render the interactive split-screen demo mode")
    demo_parser.add_argument("--length", type=int, default=1_800)
    demo_parser.add_argument("--seed", type=int, default=20261006)
    demo_parser.add_argument(
        "--out", type=Path, default=Path("simulation/analytics/out/demo.html")
    )
    backup_parser = sub.add_parser(
        "backup", help="render the auto-playing backup recording + scene pages"
    )
    backup_parser.add_argument("--length", type=int, default=1_800)
    backup_parser.add_argument("--seed", type=int, default=20261006)
    backup_parser.add_argument("--out", type=Path, default=Path("simulation/analytics/out"))
    args = parser.parse_args()

    if args.command == "build":
        payload = build(args.out, scenario=args.scenario, length=args.length, seed=args.seed)
        print(json.dumps(payload, sort_keys=True))
    elif args.command == "demo":
        from simulation.analytics import demo

        demo.build_demo(args.out, length=args.length, seed=args.seed)
        print(f"wrote {args.out}")
    elif args.command == "backup":
        from simulation.analytics import backup

        result = backup.build(args.out, length=args.length, seed=args.seed)
        print(f"wrote {args.out}/demo_backup.html and {len(result['scenes'])} scene pages")


if __name__ == "__main__":
    main()
