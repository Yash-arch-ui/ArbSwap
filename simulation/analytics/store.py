"""SQLite-backed event store (Build Plan §9.1: indexer and database).

The in-memory :class:`simulation.analytics.indexer.EventStore` is fine for a
replay; a live indexer needs persistence. This is a stdlib-only SQLite store
(no server, no dependency) that keeps events in slot order and exposes the same
views the metrics and dashboard need.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from simulation.analytics import events as ev


class SqliteEventStore:
    """Persistent event store. ``path=":memory:"`` for tests."""

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " kind TEXT NOT NULL,"
            " slot INTEGER NOT NULL,"
            " version INTEGER NOT NULL,"
            " data TEXT NOT NULL)"
        )
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_events_slot ON events(slot)")
        self.conn.commit()

    def add(self, event) -> None:
        data = ev.to_json(event)
        self.conn.execute(
            "INSERT INTO events (kind, slot, version, data) VALUES (?,?,?,?)",
            (
                data["name"],
                int(data.get("slot", 0)),
                int(data.get("version", 0)),
                json.dumps(data, sort_keys=True),
            ),
        )

    def add_many(self, events) -> int:
        count = 0
        for event in events:
            self.add(event)
            count += 1
        self.conn.commit()
        return count

    def commit(self) -> None:
        self.conn.commit()

    def all(self) -> list:
        return [
            ev.from_json(json.loads(row[0]))
            for row in self.conn.execute("SELECT data FROM events ORDER BY slot, id")
        ]

    def by_kind(self, name: str) -> list:
        return [
            ev.from_json(json.loads(row[0]))
            for row in self.conn.execute(
                "SELECT data FROM events WHERE kind=? ORDER BY slot, id", (name,)
            )
        ]

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    @property
    def swaps(self) -> list:
        return self.by_kind("SwapEvent")

    @property
    def quotes(self) -> list:
        return self.by_kind("QuoteUpdated")

    @property
    def max_slot(self) -> int:
        return self.conn.execute("SELECT COALESCE(MAX(slot),0) FROM events").fetchone()[0]

    @property
    def version(self) -> int:
        return self.conn.execute("SELECT COALESCE(MAX(version),0) FROM events").fetchone()[0]

    def close(self) -> None:
        self.conn.close()
