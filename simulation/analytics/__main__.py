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


def _default_rpc() -> str:
    """Configured RPC for the indexer (never printed). Falls back to public Devnet."""
    import os

    return os.environ.get("ARBSWAP_RPC_URL") or "https://api.devnet.solana.com"


def _add_onchain_commands(sub) -> None:
    from simulation.analytics.export import DEFAULT_CANONICAL

    c = DEFAULT_CANONICAL
    default_db = Path("simulation/analytics/out/index.sqlite")
    default_out = Path("app/public/analytics/onchain.json")

    index_p = sub.add_parser("index", help="backfill/resume on-chain events into SQLite")
    index_p.add_argument("--db", type=Path, default=default_db)
    index_p.add_argument("--rpc", default=_default_rpc())
    index_p.add_argument("--program-id", default=c.program_id)
    index_p.add_argument("--from-slot", type=int, default=None)
    index_p.add_argument("--max", type=int, default=None)
    index_p.add_argument("--batch-size", type=int, default=25)

    rec_p = sub.add_parser("reconcile", help="reconcile one signature against chain state")
    rec_p.add_argument("--db", type=Path, default=default_db)
    rec_p.add_argument("--rpc", default=_default_rpc())
    rec_p.add_argument("--signature", default=c.s215_swap)

    exp_p = sub.add_parser("export", help="write the dashboard data bundle")
    exp_p.add_argument("--db", type=Path, default=default_db)
    exp_p.add_argument("--out", type=Path, default=default_out)
    exp_p.add_argument("--rpc", default=_default_rpc())

    sync_p = sub.add_parser("sync", help="bounded index + export in one read-only pass")
    sync_p.add_argument("--db", type=Path, default=default_db)
    sync_p.add_argument("--out", type=Path, default=default_out)
    sync_p.add_argument("--rpc", default=_default_rpc())
    sync_p.add_argument("--max", type=int, default=500)
    sync_p.add_argument("--reconcile", action="store_true", help="also reconcile the canonical swap")


def _export(args) -> None:
    from simulation.analytics import export as export_mod
    from simulation.analytics import onchain_accounts as accts
    from simulation.analytics.chain import SolanaRpc
    from simulation.analytics.db import Database
    from simulation.analytics.reconcile import ReconcileTarget, reconcile_signature

    c = export_mod.DEFAULT_CANONICAL
    rpc = SolanaRpc(url=args.rpc)
    db = Database(args.db)
    snapshot = accts.read_protocol_snapshot(rpc, c.vault, c.quote_state, c.config)
    reserves = export_mod.live_reserves(rpc, c)
    try:
        current_slot = rpc.get_slot()
    except Exception:  # pragma: no cover - network
        current_slot = None
    target = ReconcileTarget(
        program_id=c.program_id, vault=c.vault, base_mint=c.base_mint, quote_mint=c.quote_mint,
        base_reserve=c.base_reserve, quote_reserve=c.quote_reserve, trader=c.trader,
        trader_base=c.trader_base, trader_quote=c.trader_quote,
    )
    reconcile = reconcile_signature(rpc, db, target, c.s215_swap)
    bundle = export_mod.build_bundle(
        db, canonical=c, snapshot=snapshot, reserves=reserves, reconcile=reconcile,
        current_slot=current_slot,
    )
    path = export_mod.write_bundle(bundle, args.out)
    print(
        f"wrote {path} ({len(bundle['swaps'])} swaps, "
        f"expired={bundle['freshness']['quote_expired']}, reconciliation={reconcile['status']})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    _add_onchain_commands(sub)
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

    if args.command == "index":
        from simulation.analytics.chain import SolanaRpc
        from simulation.analytics.db import Database
        from simulation.analytics.indexer import ChainIndexer

        rpc = SolanaRpc(url=args.rpc)
        db = Database(args.db)
        indexer = ChainIndexer(rpc, db, args.program_id, batch_size=args.batch_size)
        result = indexer.backfill(from_slot=args.from_slot, max_transactions=args.max)
        print(json.dumps(result, sort_keys=True))
    elif args.command == "sync":
        from simulation.analytics.chain import SolanaRpc
        from simulation.analytics.db import Database
        from simulation.analytics.export import DEFAULT_CANONICAL
        from simulation.analytics.indexer import ChainIndexer

        rpc = SolanaRpc(url=args.rpc)
        db = Database(args.db)
        indexer = ChainIndexer(rpc, db, DEFAULT_CANONICAL.program_id)
        result = indexer.backfill(max_transactions=args.max)
        print(json.dumps({"index": result}, sort_keys=True))
        _export(args)
    elif args.command == "reconcile":
        from simulation.analytics.chain import SolanaRpc
        from simulation.analytics.db import Database
        from simulation.analytics.export import DEFAULT_CANONICAL
        from simulation.analytics.reconcile import ReconcileTarget, reconcile_signature

        rpc = SolanaRpc(url=args.rpc)
        db = Database(args.db)
        c = DEFAULT_CANONICAL
        target = ReconcileTarget(
            program_id=c.program_id, vault=c.vault, base_mint=c.base_mint, quote_mint=c.quote_mint,
            base_reserve=c.base_reserve, quote_reserve=c.quote_reserve, trader=c.trader,
            trader_base=c.trader_base, trader_quote=c.trader_quote,
        )
        result = reconcile_signature(rpc, db, target, args.signature)
        print(json.dumps(result, indent=2, sort_keys=True))
    elif args.command == "export":
        _export(args)
    elif args.command == "build":
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
