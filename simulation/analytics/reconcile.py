"""Reconcile indexed events against independently fetched chain data.

For a given signature this re-reads the transaction from the RPC (the source of
truth), decodes the emitted events, and cross-checks them against the rows the
indexer persisted **and** against the token-account deltas in the transaction
metadata. The result is one of:

* ``MATCHED``  — every check passes;
* ``MISMATCH`` — at least one check fails (details list the failures);
* ``PENDING``  — the transaction is not yet available from the RPC (retryable).

A mismatch is never auto-corrected: the details carry the observed vs expected
values so a human can act.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from simulation.analytics import events as ev
from simulation.analytics.chain import RpcError, SolanaRpc
from simulation.analytics.onchain import parse_transaction


@dataclass(frozen=True)
class ReconcileTarget:
    program_id: str
    vault: str
    base_mint: str
    quote_mint: str
    base_reserve: str
    quote_reserve: str
    trader: str
    trader_base: str | None = None  # WSOL token account
    trader_quote: str | None = None  # USDC token account


def _account_keys(result: dict) -> list[str]:
    keys = result["transaction"]["message"]["accountKeys"]
    return [k if isinstance(k, str) else k.get("pubkey") for k in keys]


def _token_deltas(result: dict) -> dict[str, dict]:
    """Per token-account ``{pubkey: {mint, owner, delta, before, after}}``."""
    keys = _account_keys(result)
    meta = result.get("meta") or {}
    deltas: dict[str, dict] = {}

    def absorb(rows, sign: int) -> None:
        for row in rows or []:
            index = row.get("accountIndex")
            pubkey = keys[index] if index is not None and index < len(keys) else None
            if pubkey is None:
                continue
            entry = deltas.setdefault(
                pubkey, {"mint": row.get("mint"), "owner": row.get("owner"), "delta": 0, "before": 0, "after": 0}
            )
            amount = int(row["uiTokenAmount"]["amount"])
            entry["delta"] += sign * amount
            entry["before" if sign == -1 else "after"] = amount

    absorb(meta.get("preTokenBalances"), -1)
    absorb(meta.get("postTokenBalances"), +1)
    return deltas


def _indexed_swap_payloads(rows) -> list[dict]:
    out = []
    for row in rows:
        if row["event_type"] == "SwapEvent":
            out.append(json.loads(row["payload"]))
    return out


def _compare_swap(chain_swap: ev.SwapEvent, indexed: dict) -> list[str]:
    failures = []
    for field in ("version", "amount_in", "amount_out", "fee"):
        if int(indexed.get(field, -1)) != int(getattr(chain_swap, field)):
            failures.append(
                f"{field}: chain={getattr(chain_swap, field)} indexed={indexed.get(field)}"
            )
    if indexed.get("side") != chain_swap.side:
        failures.append(f"side: chain={chain_swap.side} indexed={indexed.get('side')}")
    return failures


def reconcile_signature(
    rpc: SolanaRpc, db, target: ReconcileTarget, signature: str
) -> dict:
    try:
        result = rpc.get_transaction(signature)
    except RpcError as error:
        details = {"reason": f"rpc error: {error}", "signature": signature}
        db.set_reconciliation(signature, "PENDING", details)
        return {"status": "PENDING", **details}

    if result is None:
        details = {"reason": "transaction not available yet", "signature": signature}
        db.set_reconciliation(signature, "PENDING", details)
        return {"status": "PENDING", **details}

    record = parse_transaction(result, target.program_id)
    failures: list[str] = []
    checks: dict[str, Any] = {}

    # 1. The transaction succeeded.
    checks["success"] = record.success
    if not record.success:
        failures.append(f"transaction errored: {record.err}")

    # 2. Exactly one indexed copy of each chain event.
    indexed_rows = db.events_for(signature)
    checks["indexed_event_count"] = len(indexed_rows)
    checks["chain_event_count"] = len(record.events)
    if len(indexed_rows) != len(record.events):
        failures.append(
            f"indexed {len(indexed_rows)} events but chain has {len(record.events)}"
        )

    chain_swaps = [e for e in record.events if isinstance(e, ev.SwapEvent)]
    indexed_swaps = _indexed_swap_payloads(indexed_rows)
    checks["swaps"] = len(chain_swaps)
    if len(chain_swaps) != len(indexed_swaps):
        failures.append("indexed swap count does not match chain swap count")
    for chain_swap, indexed in zip(chain_swaps, indexed_swaps):
        failures.extend(_compare_swap(chain_swap, indexed))

    # 3. Token-account deltas agree with the swap semantics.
    deltas = _token_deltas(result)
    checks["token_deltas"] = deltas
    for chain_swap in chain_swaps:
        if chain_swap.side == "buy":  # BuyBase: trader pays quote, receives base
            trader_pay, trader_get = chain_swap.amount_in, chain_swap.amount_out
            trader_pay_mint, trader_get_mint = target.quote_mint, target.base_mint
            pay_account, get_account = target.trader_quote, target.trader_base
            trader_pay_sign, trader_get_sign = -1, +1
        else:  # SellBase: trader pays base, receives quote
            trader_pay, trader_get = chain_swap.amount_in, chain_swap.amount_out
            trader_pay_mint, trader_get_mint = target.base_mint, target.quote_mint
            pay_account, get_account = target.trader_base, target.trader_quote
            trader_pay_sign, trader_get_sign = -1, +1

        paid = deltas.get(pay_account or "", {})
        received = deltas.get(get_account or "", {})
        if pay_account is None or get_account is None:
            failures.append("trader token accounts not configured for reconciliation")
            continue
        if paid.get("mint") != trader_pay_mint or paid.get("delta") != trader_pay_sign * trader_pay:
            failures.append(
                f"trader pay delta: expected -{trader_pay} of {trader_pay_mint}, got {paid.get('delta')} of {paid.get('mint')}"
            )
        if received.get("mint") != trader_get_mint or received.get("delta") != trader_get_sign * trader_get:
            failures.append(
                f"trader receive delta: expected +{trader_get} of {trader_get_mint}, got {received.get('delta')} of {received.get('mint')}"
            )

        # Vault reserves mirror the trader (opposite sign).
        base = deltas.get(target.base_reserve, {})
        quote = deltas.get(target.quote_reserve, {})
        if chain_swap.side == "buy":
            expected_base, expected_quote = -chain_swap.amount_out, +chain_swap.amount_in
        else:
            expected_base, expected_quote = +chain_swap.amount_in, -chain_swap.amount_out
        if base.get("delta") != expected_base:
            failures.append(
                f"vault base delta: expected {expected_base}, got {base.get('delta')}"
            )
        if quote.get("delta") != expected_quote:
            failures.append(
                f"vault quote delta: expected {expected_quote}, got {quote.get('delta')}"
            )

    status = "MATCHED" if not failures else "MISMATCH"
    details = {
        "signature": signature,
        "slot": record.slot,
        "block_time": record.block_time,
        "program_id": target.program_id,
        "checks": checks,
        "failures": failures,
    }
    db.set_reconciliation(signature, status, details)
    return {"status": status, **details}
