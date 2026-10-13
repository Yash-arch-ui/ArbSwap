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


# --- S2-33: coverage, cursor-resume, quote history, expired semantics --------

from simulation.analytics import export as export_mod
from simulation.analytics.events import DepositEvent, QuoteCommitted, SwapEvent
from simulation.analytics.onchain import TxRecord


class FakeSignedRpc:
    """Newest-first signature list; returns a canned tx per signature."""

    def __init__(self, entries, result_by_sig):
        self.entries = entries  # newest-first [{"signature","slot","err"}]
        self.result_by_sig = result_by_sig

    def get_signatures_for_address(self, address, *, limit=1000, before=None, until=None, commitment="confirmed"):
        return list(self.entries)

    def get_transaction(self, signature):
        return self.result_by_sig.get(signature)


def _record(signature, slot, events):
    return TxRecord(signature=signature, slot=slot, block_time=slot * 2, err=None,
                    program_id=DEFAULT_CANONICAL.program_id, events=tuple(events))


def test_cursor_resume_only_collects_newer_signatures(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    # Pre-existing cursor at the older signature.
    old = _record("OLD", 100, [SwapEvent(slot=100, version=1, side="buy", amount_in=1, amount_out=2, fee=0)])
    db.ingest_records(DEFAULT_CANONICAL.program_id, [old])
    assert db.cursor(DEFAULT_CANONICAL.program_id)[0] == "OLD"

    new = _record("NEW", 300, [SwapEvent(slot=300, version=2, side="sell", amount_in=3, amount_out=4, fee=0)])
    rpc = FakeSignedRpc(
        entries=[{"signature": "NEW", "slot": 300, "err": None},
                 {"signature": "OLD", "slot": 100, "err": None}],
        result_by_sig={"NEW": "NEW", "OLD": "OLD"},
    )
    # The indexer parses results itself, so give it parseable results via monkeypatch.
    from simulation.analytics import indexer as idx
    parsed = {"NEW": new, "OLD": old}
    orig = idx.parse_transaction
    idx.parse_transaction = lambda result, program_id: parsed[result]
    try:
        summary = idx.ChainIndexer(rpc, db, DEFAULT_CANONICAL.program_id, log=lambda *_: None).backfill()
    finally:
        idx.parse_transaction = orig
    # Only NEW is collected; OLD stops the walk.
    assert summary["candidates"] == 1
    assert db.cursor(DEFAULT_CANONICAL.program_id)[0] == "NEW"
    # OLD was not re-ingested (still exactly 2 swaps).
    assert db.counts()["swaps"] == 2


def test_cursor_never_moves_backwards(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    newer = _record("NEW", 300, [])
    older = _record("OLD", 100, [])
    db.ingest_records(DEFAULT_CANONICAL.program_id, [newer])
    assert db.cursor(DEFAULT_CANONICAL.program_id)[0] == "NEW"
    # Ingest an older batch afterwards: cursor must stay at NEW.
    db.ingest_records(DEFAULT_CANONICAL.program_id, [older])
    assert db.cursor(DEFAULT_CANONICAL.program_id)[0] == "NEW"


def test_coverage_reports_honest_range(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    db.ingest_records(DEFAULT_CANONICAL.program_id, [
        _record("A", 100, [DepositEvent(slot=100, shares=10, base_amount=1, quote_amount=2)]),
        _record("B", 200, [QuoteCommitted(slot=200, version=5, nonce=9)]),
    ])
    cov = db.coverage()
    assert cov["first_slot"] == 100 and cov["last_slot"] == 200
    assert cov["transactions"] == 2 and cov["events"] == 2
    assert cov["first_indexed_at"] and cov["last_indexed_at"]


def test_quote_commits_view(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    db.ingest_records(DEFAULT_CANONICAL.program_id, [
        _record("A", 100, [QuoteCommitted(slot=100, version=1, nonce=1)]),
        _record("B", 200, [QuoteCommitted(slot=200, version=2, nonce=2)]),
    ])
    commits = db.quote_commits()
    assert [c["slot"] for c in commits] == [200, 100]  # newest first


def test_build_bundle_history_and_expired_semantics(tmp_path):
    db = Database(tmp_path / "index.sqlite")
    db.ingest_records(DEFAULT_CANONICAL.program_id, [
        _record("A", 100, [
            SwapEvent(slot=100, version=5, side="buy", amount_in=1_000_000, amount_out=9_000_000, fee=100),
            DepositEvent(slot=100, shares=42, base_amount=10, quote_amount=20),
            QuoteCommitted(slot=100, version=5, nonce=7),
        ]),
    ])
    bundle = export_mod.build_bundle(
        db,
        snapshot={"quote_state": {"version": 5, "expiry_slot": 150, "keeper": "K"}},
        reserves={"base": 1, "quote": 2},
        generated_at="2026-01-01T00:00:00+00:00",
        current_slot=150,
    )
    assert bundle["history"]["swaps"][0]["payload"]["side"] == "buy"
    assert bundle["history"]["deposits"][0]["payload"]["shares"] == 42
    assert bundle["history"]["quote_commits"][0]["payload"]["version"] == 5
    assert bundle["index_status"]["coverage"]["first_slot"] == 100
    # expiry_slot == current_slot -> expired (strict < required for fresh)
    assert bundle["freshness"]["quote_expired"] is True
    assert bundle["protocol_live"]["quote_expired"] is True
    # Fresh when current slot precedes expiry.
    fresh = export_mod.build_bundle(
        db, snapshot={"quote_state": {"version": 5, "expiry_slot": 150}}, current_slot=149,
    )
    assert fresh["freshness"]["quote_expired"] is False
    # Version 0 is never "fresh".
    zero = export_mod.build_bundle(
        db, snapshot={"quote_state": {"version": 0, "expiry_slot": 150}}, current_slot=100,
    )
    assert zero["freshness"]["quote_expired"] is True


def test_analytics_service_never_submits_or_signs():
    """The analytics/indexer package is read-only: no signing or send paths."""
    import simulation.analytics as pkg
    from pathlib import Path

    root = Path(pkg.__file__).parent
    banned = ("sendTransaction", "sendRawTransaction", "signTransaction",
              "secretKey", "from_secret_key", "Keypair")
    offenders = []
    for py in root.glob("*.py"):
        text = py.read_text()
        for token in banned:
            if token in text:
                offenders.append(f"{py.name}:{token}")
    assert offenders == [], offenders
