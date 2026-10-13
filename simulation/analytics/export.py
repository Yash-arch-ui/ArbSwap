"""Assemble the dashboard data bundle from the index + live chain reads.

Writes ``app/public/analytics/onchain.json`` which the SPA fetches at
``/analytics/onchain.json``. The bundle keeps **live** on-chain values and
**historical** indexed values in separate sections and never mixes them.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from simulation.analytics import onchain_accounts as accts
from simulation.analytics import onchain_metrics as om


@dataclass(frozen=True)
class Canonical:
    program_id: str
    vault: str
    config: str
    quote_state: str
    base_mint: str
    quote_mint: str
    base_reserve: str
    quote_reserve: str
    trader: str
    trader_base: str
    trader_quote: str
    s215_swap: str = "51TkKqfi9bt8QqpKKxJZnN2nyFv1HAMnSGW2mjctDYDEpuDi4Roch43RJapj3poz8H8DqYCfmE8QFSrbxVHx9TUC"


DEFAULT_CANONICAL = Canonical(
    program_id="2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm",
    vault="8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt",
    config="ErVDFAHWSK5SjKqvaNJoqv91r4vNH7VmqteURqdEo2aT",
    quote_state="5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG",
    base_mint="So11111111111111111111111111111111111111112",
    quote_mint="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    base_reserve="8vfr2KmMmXYUTjRg5cAiSYD6EhN1d8pjJnmFC95E2vfm",
    quote_reserve="G8q1WMKT8fnGQh85kCB8Aihf6F7tctXJDKbA6gn1jPeS",
    trader="8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH",
    trader_base="5MpRjKvzgW5C7x8sbam4KgA5KGkGyTKNCXarbqZceCnJ",
    trader_quote="5SThVCCb6vrvvkwSMukanW5vWkUehBCVW8iT53KqVzgV",
)


def _event_payload(row) -> dict:
    payload = json.loads(row["payload"])
    return {
        "signature": row["signature"],
        "slot": row["slot"],
        "block_time": row["block_time"],
        "event_type": row["event_type"],
        "payload": payload,
    }


def live_reserves(rpc, canonical: Canonical) -> dict:
    out: dict[str, Any] = {}
    for name, address in (("base", canonical.base_reserve), ("quote", canonical.quote_reserve)):
        try:
            value = rpc.get_account_info(address)
            out[name] = None if not value else accts.decode_token_amount(accts._b64(value))
        except Exception:  # pragma: no cover - network
            out[name] = None
    return out


def build_bundle(
    db,
    *,
    canonical: Canonical = DEFAULT_CANONICAL,
    snapshot: dict | None = None,
    reserves: dict | None = None,
    reconcile: dict | None = None,
    generated_at: str | None = None,
) -> dict:
    last_sig, last_slot = db.cursor(canonical.program_id)
    event_rows = db.events(order="slot DESC, event_index DESC")
    swap_rows = db.swaps()
    ingest_errors = [
        {
            "signature": row["signature"], "slot": row["slot"],
            "method": row["method"], "message": row["message"], "created_at": row["created_at"],
        }
        for row in db.ingest_error_rows()
    ]
    swaps = [_event_payload(row) for row in swap_rows]
    activity = [_event_payload(row) for row in event_rows[:50]]

    quote_state = (snapshot or {}).get("quote_state")
    vault = (snapshot or {}).get("vault")
    return {
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "network": "devnet",
        "canonical": asdict(canonical),
        "index_status": {
            "schema_version": db.schema_version(),
            "last_signature": last_sig,
            "last_slot": last_slot,
            "counts": db.counts(),
            "ingest_errors": ingest_errors,
        },
        "protocol_live": {
            "source": "live RPC reads",
            "vault": vault,
            "quote_state": quote_state,
            "config": (snapshot or {}).get("config"),
            "reserves": reserves,
            "quote_expired": None if not quote_state else (
                None  # needs the current slot; supplied by the client against its own clock
            ),
        },
        "trading": om.trader_metrics(db),
        "lp": om.lp_metrics(db, snapshot or {}),
        "execution": om.execution_metrics(swap_rows),
        "markouts": om.markouts(swap_rows),
        "swaps": swaps,
        "activity": activity,
        "reconciliation": reconcile or {"status": "PENDING", "reason": "not run in this export"},
        "limitations": [
            "No historical Pyth/SOL observations are indexed: markouts and quote-age are PENDING.",
            "min_out is an instruction argument, not an event field: shown as N/A.",
            "Fee buckets are liabilities, not LP profit; inventory changes are not PnL.",
            "Block times are absent on very old transactions; those rows carry null block_time.",
        ],
    }


def write_bundle(bundle: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    return path
