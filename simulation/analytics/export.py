"""Assemble a standalone historical/read-only on-chain analytics bundle.

Writes ``app/public/analytics/onchain.json`` as a **standalone export** (live
on-chain snapshot + historical indexed sections, never mixed). NOTE (S2-24): the
current SPA does **not** fetch ``/analytics/onchain.json`` — it reads only the
static ``/artifacts/*`` bundle and live on-chain state. This export is optional
tooling, not a frontend dependency; wiring it into the UI is tracked in
``docs/INTEGRATION_GAPS.md``. Do not present these values as live in the app.
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
    current_slot: int | None = None,
) -> dict:
    last_sig, last_slot = db.cursor(canonical.program_id)
    event_rows = db.events(order="slot DESC, event_index DESC")
    swap_rows = db.swaps()
    deposit_rows = db.deposits()
    withdrawal_rows = db.withdrawals()
    quote_rows = db.quote_commits()
    ingest_errors = [
        {
            "signature": row["signature"], "slot": row["slot"],
            "method": row["method"], "message": row["message"], "created_at": row["created_at"],
        }
        for row in db.ingest_error_rows()
    ]
    coverage = db.coverage()
    swaps = [_event_payload(row) for row in swap_rows]
    activity = [_event_payload(row) for row in event_rows[:50]]

    quote_state = (snapshot or {}).get("quote_state")
    vault = (snapshot or {}).get("vault")
    expiry_slot = (quote_state or {}).get("expiry_slot")
    quote_expired = (
        None
        if current_slot is None or expiry_slot is None
        else (int(current_slot) >= int(expiry_slot) or int(quote_state.get("version", 0)) == 0)
    )
    return {
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "network": "devnet",
        "canonical": asdict(canonical),
        "index_status": {
            "schema_version": db.schema_version(),
            "last_signature": last_sig,
            "last_slot": last_slot,
            "last_indexed_at": coverage["last_indexed_at"],
            "coverage": coverage,
            "counts": db.counts(),
            "ingest_errors": ingest_errors,
        },
        "freshness": {
            "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
            "current_slot": current_slot,
            "quote_version": None if not quote_state else quote_state.get("version"),
            "quote_expiry_slot": expiry_slot,
            "quote_expired": quote_expired,
            "source": "live RPC reads at export time",
        },
        "protocol_live": {
            "source": "live RPC reads",
            "vault": vault,
            "quote_state": quote_state,
            "config": (snapshot or {}).get("config"),
            "reserves": reserves,
            "quote_expired": quote_expired,
        },
        "history": {
            "source": "indexed confirmed transactions (program events)",
            "coverage": coverage,
            "swaps": swaps,
            "deposits": [_event_payload(row) for row in deposit_rows],
            "withdrawals": [_event_payload(row) for row in withdrawal_rows],
            "quote_commits": [_event_payload(row) for row in quote_rows[:100]],
            "quote_commits_truncated": max(0, len(quote_rows) - 100),
            "quote_attribution_note": (
                "QuoteStaged/QuoteCommitted events carry version + nonce but not the keeper; "
                "keeper attribution is only observable from the live QuoteState account, not "
                "retroactively from events."
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
            "Coverage is bounded by what the configured RPC provider retains; earlier history is a gap, not zero activity.",
            "No historical Pyth/SOL observations are indexed: markouts and quote-age are PENDING.",
            "min_out is an instruction argument, not an event field: shown as N/A.",
            "Quote attribution (keeper) is not reconstructable from events; only the live QuoteState keeper is shown.",
            "Fee buckets are liabilities, not LP profit; inventory changes are not PnL.",
            "Block times are absent on very old transactions; those rows carry null block_time.",
        ],
    }


def write_bundle(bundle: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    return path
