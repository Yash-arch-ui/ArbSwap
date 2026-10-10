"""Live indexer (Build Plan §9.1): poll a cluster for the program's
transactions, parse the Anchor events, and persist them to a SQLite database.

Stdlib only (``urllib`` + ``json``). The parse step reuses
:func:`simulation.analytics.events.parse_logs`, so a live event and a replayed
event go through exactly the same decoder.

    python -m simulation.analytics.live --rpc <url> --program <id> --db <path> [--once]

Secrets are never read here; the RPC URL is public.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

from simulation.analytics import events as ev
from simulation.analytics.store import SqliteEventStore


def rpc_call(rpc_url: str, method: str, params: list, *, timeout: float = 30.0):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        rpc_url, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def signatures(rpc_url: str, program_id: str, *, limit: int = 100, before: str | None = None) -> list[str]:
    options: dict = {"limit": limit}
    if before:
        options["before"] = before
    result = rpc_call(rpc_url, "getSignaturesForAddress", [program_id, options])
    return [entry["signature"] for entry in result.get("result", [])]


def transaction_logs(rpc_url: str, signature: str) -> list[str]:
    result = rpc_call(
        rpc_url,
        "getTransaction",
        [signature, {"encoding": "json", "maxSupportedTransactionVersion": 0}],
    ).get("result")
    if not result:
        return []
    return (result.get("meta") or {}).get("logMessages") or []


def poll_once(
    rpc_url: str,
    program_id: str,
    store: SqliteEventStore,
    *,
    limit: int = 100,
    before: str | None = None,
    pause: float = 0.0,
) -> tuple[int, str | None]:
    """Index one batch of signatures. Returns ``(events_added, oldest_signature)``."""
    sigs = signatures(rpc_url, program_id, limit=limit, before=before)
    added = 0
    for signature in sigs:
        for event in ev.parse_logs(transaction_logs(rpc_url, signature)):
            store.add(event)
            added += 1
        if pause:
            time.sleep(pause)
    store.commit()
    return added, (sigs[-1] if sigs else before)


def run(
    rpc_url: str,
    program_id: str,
    db_path: str | Path,
    *,
    interval: float = 5.0,
    limit: int = 100,
    once: bool = False,
) -> SqliteEventStore:
    store = SqliteEventStore(db_path)
    before: str | None = None
    while True:
        added, before = poll_once(rpc_url, program_id, store, limit=limit, before=before)
        print(f"indexed +{added} events; total {store.count()} (slot {store.max_slot})", flush=True)
        if once:
            return store
        time.sleep(interval)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", required=True)
    parser.add_argument("--program", required=True)
    parser.add_argument("--db", default="simulation/analytics/out/events.db")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    run(args.rpc, args.program, args.db, interval=args.interval, limit=args.limit, once=args.once)


if __name__ == "__main__":
    main()
