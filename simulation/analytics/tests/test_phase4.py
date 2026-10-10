"""Phase-4 completion tests: SQLite store, live indexer, interactive demo mode."""

from __future__ import annotations

from simulation.analytics import demo, events as ev, live
from simulation.analytics.store import SqliteEventStore


def test_sqlite_store_round_trips_and_orders_by_slot():
    store = SqliteEventStore(":memory:")
    store.add(ev.SwapEvent(slot=5, version=2, side="buy", amount_in=1, amount_out=2, fee=0))
    store.add(ev.QuoteUpdated(slot=3, version=2, anchor_sqrt_price=1, depth_mult_bps=9_000))
    store.commit()
    assert store.count() == 2
    assert [event.slot for event in store.all()] == [3, 5]
    assert store.version == 2
    assert store.max_slot == 5
    assert store.swaps[0].amount_out == 2


def test_live_indexer_parses_anchor_events(monkeypatch):
    log = ev.encode_log(
        "SwapEvent", slot=10, version=1, side="buy", amount_in=1, amount_out=2, fee=0
    )
    monkeypatch.setattr(live, "signatures", lambda *a, **k: ["sig1"])
    monkeypatch.setattr(live, "transaction_logs", lambda *a, **k: [log])
    store = SqliteEventStore(":memory:")
    added, before = live.poll_once("http://example.invalid", "prog", store)
    assert added == 1
    assert store.count() == 1
    assert store.swaps[0].slot == 10
    assert before == "sig1"


def test_demo_is_deterministic_and_offline():
    first = demo.build_data(length=120, seed=1)
    second = demo.build_data(length=120, seed=1)
    assert first == second, "the demo dataset must be deterministic"
    html = demo.render(first)
    # No network / CDN / external resources.
    assert "http://" not in html
    assert "https://" not in html
    assert "cdn" not in html.lower()
    assert "<script src" not in html


def test_demo_has_scenario_selector_and_attack_buttons():
    data = demo.build_data(length=120, seed=1)
    assert set(data) == {f"{s}:{a}" for s in demo.SCENARIOS for a in demo.ATTACKS}
    html = demo.render(data)
    assert 'id="scenario"' in html
    for attack in demo.ATTACKS:
        assert f'data-attack="{attack}"' in html


def test_demo_attack_changes_the_vault_series():
    data = demo.build_data(length=120, seed=1)
    baseline = data["trend:none"]["ArbSwap"]["value_path"]
    killed = data["trend:kill_keeper"]["ArbSwap"]["value_path"]
    frozen = data["trend:freeze_oracle"]["ArbSwap"]["value_path"]
    assert baseline != killed, "killing the keeper must change the vault replay"
    assert baseline != frozen, "freezing the oracle must change the vault replay"
