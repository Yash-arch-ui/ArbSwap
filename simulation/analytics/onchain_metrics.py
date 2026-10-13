"""On-chain analytics computed from indexed events + a live account snapshot.

Every metric declares its ``source`` and a ``status``:

* ``live``        — read from chain this run (via the snapshot);
* ``historical``  — computed from indexed, reconciled events;
* ``pending``     — the data needed is not in this index yet (e.g. markouts);
* ``unavailable`` — the metric is not supported by the current protocol data.

Nothing is fabricated: unavailable values are ``None`` with a reason, never a
placeholder number. Fee events are explicitly **not** relabelled as LP profit,
and inventory changes are explicitly **not** relabelled as PnL.
"""

from __future__ import annotations

from simulation.analytics import events as ev

BASE_DECIMALS = 9
QUOTE_DECIMALS = 6


def _side_swap(row) -> dict:
    import json

    return json.loads(row["payload"])


def trader_metrics(db) -> dict:
    swaps = [_side_swap(row) for row in db.swaps()]
    transactions = db.transactions()
    buys = [s for s in swaps if s["side"] == "buy"]
    sells = [s for s in swaps if s["side"] == "sell"]
    usdc_in = sum(s["amount_in"] for s in buys)
    wsol_out = sum(s["amount_out"] for s in buys)
    wsol_in = sum(s["amount_in"] for s in sells)
    usdc_out = sum(s["amount_out"] for s in sells)

    def avg(num: int, den: int) -> float | None:
        return None if den == 0 else num / den

    failed = sum(1 for t in transactions if not t["success"])
    return {
        "source": "indexed SwapEvent + transactions",
        "status": "historical",
        "trade_count": len(swaps),
        "failed_transactions": failed,
        "success_rate": None if (len(swaps) + failed) == 0 else len(swaps) / (len(swaps) + failed),
        "buy_base": {
            "count": len(buys),
            "usdc_in_atoms": usdc_in,
            "wsol_out_atoms": wsol_out,
            "fee_usdc_atoms": sum(s["fee"] for s in buys),
            "avg_execution_price_usdc_per_sol": avg(usdc_in / 10**QUOTE_DECIMALS, wsol_out / 10**BASE_DECIMALS),
        },
        "sell_base": {
            "count": len(sells),
            "wsol_in_atoms": wsol_in,
            "usdc_out_atoms": usdc_out,
            "fee_wsol_atoms": sum(s["fee"] for s in sells),
            "avg_execution_price_usdc_per_sol": avg(usdc_out / 10**QUOTE_DECIMALS, wsol_in / 10**BASE_DECIMALS),
        },
        "units": {
            "usdc": "atoms (6 dp)", "wsol": "atoms (9 dp)",
            "avg_execution_price_usdc_per_sol": "USDC per SOL",
        },
    }


def lp_metrics(db, snapshot: dict) -> dict:
    vault = (snapshot or {}).get("vault")
    quote_state = (snapshot or {}).get("quote_state")
    deposits = [_side_swap(r) for r in db.deposits()]
    withdrawals = [_side_swap(r) for r in db.withdrawals()]

    price_raw = None
    if quote_state and quote_state.get("oracle_price"):
        price_raw = quote_state["oracle_price"] / float(1 << 64)
    price_human = None if price_raw is None else price_raw * (10 ** (BASE_DECIMALS - QUOTE_DECIMALS))

    reserves = None
    composition = None
    if vault:
        base_reserve = None  # read separately by the caller; snapshot carries shares/buckets
        reserves = {
            "total_shares": vault["total_shares"],
            "insurance_base": vault["insurance_base"], "insurance_quote": vault["insurance_quote"],
            "keeper_base": vault["keeper_base"], "keeper_quote": vault["keeper_quote"],
            "protocol_base": vault["protocol_base"], "protocol_quote": vault["protocol_quote"],
            "status": vault["status"], "epoch": vault["epoch"],
        }
        if price_human is not None:
            composition = {"oracle_price_usdc_per_sol": price_human}

    return {
        "source": "live Vault/QuoteState + indexed deposit/withdraw events",
        "status": "live+historical",
        "reserves": reserves,
        "reserve_composition": composition,
        "deposits": {
            "count": len(deposits),
            "shares_minted": sum(d["shares"] for d in deposits),
            "wsol_atoms": sum(d["base_amount"] for d in deposits),
            "usdc_atoms": sum(d["quote_amount"] for d in deposits),
        },
        "withdrawals": {
            "count": len(withdrawals),
            "shares": sum(w["shares"] for w in withdrawals),
            "wsol_atoms": sum(w["base_amount"] for w in withdrawals),
            "usdc_atoms": sum(w["quote_amount"] for w in withdrawals),
        },
        "protocol_fee_buckets": None,
        "protocol_fee_buckets_reason": (
            "Fee buckets accrue inside the Vault account and are not emitted as events; "
            "read from the Vault snapshot, but they are a liability, not LP profit."
        ),
        "nav_per_share": None,
        "nav_per_share_reason": "NAV requires a reserve valuation; shown only when a live oracle price is available.",
        "units": {"wsol": "atoms (9 dp)", "usdc": "atoms (6 dp)", "shares": "atoms (9 dp)"},
    }


def execution_metrics(swaps_rows) -> dict:
    out = []
    for row in swaps_rows:
        payload = _side_swap(row)
        out.append({
            "signature": row["signature"],
            "slot": row["slot"],
            "block_time": row["block_time"],
            "side": payload["side"],
            "amount_in_atoms": payload["amount_in"],
            "amount_out_atoms": payload["amount_out"],
            "fee_atoms": payload["fee"],
            "quote_version": payload["version"],
            "min_out_atoms": None,
            "min_out_reason": "min_out is a swap instruction argument, not emitted in the event.",
            "quote_age_seconds": None,
            "quote_age_reason": "would require joining the swap to the QuoteStaged oracle_publish_time; not yet implemented.",
        })
    return {"source": "indexed SwapEvent", "status": "historical", "swaps": out}


def markouts(swaps_rows) -> dict:
    return {
        "source": "post-trade oracle observations",
        "status": "pending",
        "horizons_seconds": [1, 5, 30],
        "observations": [],
        "reason": (
            "No historical Pyth/SOL price observations are indexed, so post-trade markouts "
            "cannot be computed. Current prices are never substituted for historical ones."
        ),
    }
