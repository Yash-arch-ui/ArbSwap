"""Deterministic tests for the on-chain indexer, reconciliation, and metrics.

The S2-15 fixture is the real ``getTransaction`` result for the first live
BuyBase swap (captured from devnet), so the parser and reconciliation run
against genuine bytes without a live RPC.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from simulation.analytics import events as ev
from simulation.analytics import onchain_metrics as om
from simulation.analytics.chain import RpcError
from simulation.analytics.db import Database
from simulation.analytics.export import DEFAULT_CANONICAL
from simulation.analytics.indexer import ChainIndexer
from simulation.analytics.onchain import parse_transaction
from simulation.analytics.reconcile import ReconcileTarget, reconcile_signature

FIXTURE = Path(__file__).parent / "fixtures" / "s215_swap_tx.json"
S215 = DEFAULT_CANONICAL.s215_swap


def load_result() -> dict:
    return json.loads(FIXTURE.read_text())["result"]


class FakeRpc:
    """In-memory RPC returning the fixture; supports injected failures."""

    def __init__(self, result: dict, signatures: list[dict] | None = None, fail: dict | None = None):
        self.result = result
        self.signature = result["transaction"]["signatures"][0]
        self.signatures = signatures or [
            {"signature": self.signature, "slot": result["slot"], "err": None}
        ]
        self.fail = fail or {}

    def get_transaction(self, signature: str):
        if signature in self.fail:
            raise RpcError("getTransaction", self.fail[signature])
        return self.result if signature == self.signature else None

    def get_signatures_for_address(self, address, *, limit=1000, before=None, until=None, commitment="confirmed"):
        return [s for s in self.signatures if before is None or s["signature"] != before]


def test_parse_s215_swap_event():
    record = parse_transaction(load_result(), DEFAULT_CANONICAL.program_id)
    assert record.signature == S215
    assert record.slot == 510407827
    assert record.success
    swaps = [e for e in record.events if isinstance(e, ev.SwapEvent)]
    assert len(swaps) == 1
    swap = swaps[0]
    assert swap.side == "buy"
    assert swap.version == 18
    assert swap.amount_in == 1_750_000
    assert swap.amount_out == 16_290_295
    assert swap.fee == 175


def test_discriminator_matches_anchor_and_fixture():
    assert ev.discriminator("SwapEvent") == (
        b"\x40\xc6\xcd\xe8\x26\x08\x71\xe2"
    )
    log = next(l for l in load_result()["meta"]["logMessages"] if l.startswith("Program data"))
    import base64

    payload = base64.b64decode(log.split(": ", 1)[1])
    assert payload[:8] == ev.discriminator("SwapEvent")


def test_ingest_is_idempotent(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    record = parse_transaction(load_result(), DEFAULT_CANONICAL.program_id)
    first = db.ingest_records(DEFAULT_CANONICAL.program_id, [record])
    assert first["transactions_inserted"] == 1
    assert first["events_inserted"] == 1
    second = db.ingest_records(DEFAULT_CANONICAL.program_id, [record])
    assert second["transactions_inserted"] == 0
    assert second["events_inserted"] == 0
    assert db.counts()["events"] == 1
    assert db.counts()["transactions"] == 1


def test_migration_and_reopen(tmp_path):
    path = tmp_path / "index.sqlite"
    db = Database(path)
    assert db.schema_version() == 1
    assert db.counts()["schema_version"] == 1
    db.conn.close()
    reopened = Database(path)
    assert reopened.schema_version() == 1


def test_reconcile_s215_matched(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    rpc = FakeRpc(load_result())
    record = parse_transaction(load_result(), DEFAULT_CANONICAL.program_id)
    db.ingest_records(DEFAULT_CANONICAL.program_id, [record])
    c = DEFAULT_CANONICAL
    target = ReconcileTarget(
        program_id=c.program_id, vault=c.vault, base_mint=c.base_mint, quote_mint=c.quote_mint,
        base_reserve=c.base_reserve, quote_reserve=c.quote_reserve, trader=c.trader,
        trader_base=c.trader_base, trader_quote=c.trader_quote,
    )
    result = reconcile_signature(rpc, db, target, S215)
    assert result["status"] == "MATCHED", result["failures"]
    assert db.get_reconciliation(S215)["status"] == "MATCHED"


def test_reconcile_detects_tampered_row(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    rpc = FakeRpc(load_result())
    record = parse_transaction(load_result(), DEFAULT_CANONICAL.program_id)
    db.ingest_records(DEFAULT_CANONICAL.program_id, [record])
    with db.conn:
        row = db.conn.execute(
            "SELECT payload FROM tx_events WHERE event_type = 'SwapEvent'"
        ).fetchone()
        payload = json.loads(row["payload"])
        payload["amount_in"] = 999
        db.conn.execute(
            "UPDATE tx_events SET payload = ? WHERE event_type = 'SwapEvent'",
            (json.dumps(payload),),
        )
    c = DEFAULT_CANONICAL
    target = ReconcileTarget(
        program_id=c.program_id, vault=c.vault, base_mint=c.base_mint, quote_mint=c.quote_mint,
        base_reserve=c.base_reserve, quote_reserve=c.quote_reserve, trader=c.trader,
        trader_base=c.trader_base, trader_quote=c.trader_quote,
    )
    result = reconcile_signature(rpc, db, target, S215)
    assert result["status"] == "MISMATCH"
    assert any("amount_in" in failure for failure in result["failures"])


def test_reconcile_pending_when_absent(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    rpc = FakeRpc(load_result())
    c = DEFAULT_CANONICAL
    target = ReconcileTarget(
        program_id=c.program_id, vault=c.vault, base_mint=c.base_mint, quote_mint=c.quote_mint,
        base_reserve=c.base_reserve, quote_reserve=c.quote_reserve, trader=c.trader,
    )
    result = reconcile_signature(rpc, db, target, "nonexistent-signature")
    assert result["status"] == "PENDING"


def test_backfill_records_error_and_holds_cursor(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    result = load_result()
    sig = result["transaction"]["signatures"][0]
    rpc = FakeRpc(result, signatures=[{"signature": sig, "slot": result["slot"], "err": None}])
    rpc.fail = {sig: "rpc down"}
    indexer = ChainIndexer(rpc, db, DEFAULT_CANONICAL.program_id, log=lambda *_: None)
    summary = indexer.backfill()
    assert summary["processed"] == 0
    assert db.counts()["ingest_errors"] >= 1
    # Cursor did not advance past the failure, so a later run resumes here.
    assert db.cursor(DEFAULT_CANONICAL.program_id)[0] is None


def test_backfill_replay_is_a_noop(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    result = load_result()
    sig = result["transaction"]["signatures"][0]
    rpc = FakeRpc(result, signatures=[{"signature": sig, "slot": result["slot"], "err": None}])
    indexer = ChainIndexer(rpc, db, DEFAULT_CANONICAL.program_id, log=lambda *_: None)
    indexer.backfill()
    indexer.backfill()  # resume: nothing new
    assert db.counts()["events"] == 1
    assert db.counts()["transactions"] == 1


def test_metrics_unavailable_are_none_not_fabricated(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    record = parse_transaction(load_result(), DEFAULT_CANONICAL.program_id)
    db.ingest_records(DEFAULT_CANONICAL.program_id, [record])
    trader = om.trader_metrics(db)
    assert trader["trade_count"] == 1
    assert trader["buy_base"]["usdc_in_atoms"] == 1_750_000
    execution = om.execution_metrics(db.swaps())
    assert execution["swaps"][0]["min_out_atoms"] is None
    mark = om.markouts(db.swaps())
    assert mark
    assert mark["status"] == "pending"
    assert mark["observations"] == []
