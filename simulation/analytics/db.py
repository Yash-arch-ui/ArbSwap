"""SQLite persistence for the on-chain indexer (Build Plan §9.1).

Design goals:

* **Idempotent** — events are keyed ``(signature, event_index)`` and transactions
  by ``signature``; replaying a transaction with ``INSERT OR IGNORE`` never
  duplicates a row.
* **Atomic batches** — one coherent ingestion batch (a set of transactions and
  their events plus the cursor advance) commits in a single SQLite transaction;
  a crash mid-batch leaves the previous cursor, so nothing is skipped silently.
* **Resumable** — ``indexer_cursor`` records the last safely persisted
  ``(slot, signature)`` per program so a restart continues from there.
* **Auditable** — ``ingest_errors`` records failures (with the RPC method and
  message) instead of dropping a range, and ``schema_migrations`` records every
  schema change.
* Raw source facts live in ``transactions`` / ``tx_events``; derived metrics are
  never written here (they are recomputed from the raw rows).
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Sequence

SCHEMA_VERSION = 1

_MIGRATIONS: dict[int, str] = {
    1: """
    CREATE TABLE schema_migrations(
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    );
    CREATE TABLE transactions(
        signature TEXT PRIMARY KEY,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        err TEXT,
        program_id TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        success INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
    );
    CREATE INDEX idx_transactions_slot ON transactions(slot);
    CREATE TABLE tx_events(
        signature TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        program_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        side TEXT,
        quote_version INTEGER,
        amount_in INTEGER,
        amount_out INTEGER,
        fee INTEGER,
        payload TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY(signature, event_index)
    );
    CREATE INDEX idx_tx_events_slot ON tx_events(slot);
    CREATE INDEX idx_tx_events_type ON tx_events(event_type);
    CREATE TABLE indexer_cursor(
        program_id TEXT PRIMARY KEY,
        last_signature TEXT,
        last_slot INTEGER,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE ingest_errors(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id TEXT,
        signature TEXT,
        slot INTEGER,
        method TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE reconciliations(
        signature TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        details TEXT NOT NULL,
        checked_at TEXT NOT NULL
    );
    """,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    """A thin, explicit SQLite wrapper (no ORM)."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    # --- schema -----------------------------------------------------------
    def _migrate(self) -> None:
        current = self.conn.execute("PRAGMA user_version").fetchone()[0]
        applied = set()
        try:
            applied = {
                row[0]
                for row in self.conn.execute("SELECT version FROM schema_migrations")
            }
        except sqlite3.OperationalError:
            pass  # fresh database
        for version in sorted(_MIGRATIONS):
            if version in applied or version <= current:
                continue
            with self.conn:  # one atomic transaction per migration
                self.conn.executescript(_MIGRATIONS[version])
                self.conn.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, _now()),
                )
                self.conn.execute(f"PRAGMA user_version = {version}")

    def schema_version(self) -> int:
        return int(self.conn.execute("PRAGMA user_version").fetchone()[0])

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            self.conn.execute("BEGIN")
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    # --- ingestion --------------------------------------------------------
    def ingest_records(self, program_id: str, records: Sequence) -> dict:
        """Atomically insert a batch of :class:`TxRecord`s + advance the cursor.

        Records must be ordered ascending by slot. Returns counts. Re-ingesting
        the same records is a no-op (idempotent).
        """
        inserted_tx = inserted_ev = 0
        highest: tuple[int, str] | None = None
        with self.transaction() as conn:
            for record in records:
                cur = conn.execute(
                    """INSERT OR IGNORE INTO transactions
                       (signature, slot, block_time, err, program_id, event_count, success, indexed_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        record.signature,
                        record.slot,
                        record.block_time,
                        None if record.err is None else json.dumps(record.err),
                        program_id,
                        len(record.events),
                        1 if record.err is None else 0,
                        _now(),
                    ),
                )
                inserted_tx += cur.rowcount
                for index, event in enumerate(record.events):
                    payload = json.dumps(_event_payload(event), sort_keys=True)
                    cur = conn.execute(
                        """INSERT OR IGNORE INTO tx_events
                           (signature, event_index, slot, block_time, program_id, event_type,
                            side, quote_version, amount_in, amount_out, fee, payload, indexed_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            record.signature,
                            index,
                            record.slot,
                            record.block_time,
                            program_id,
                            type(event).__name__,
                            _prop(event, "side"),
                            _prop(event, "version"),
                            _prop(event, "amount_in"),
                            _prop(event, "amount_out"),
                            _prop(event, "fee"),
                            payload,
                            _now(),
                        ),
                    )
                    inserted_ev += cur.rowcount
                if highest is None or record.slot >= highest[0]:
                    highest = (record.slot, record.signature)
            if highest is not None:
                # Advance the cursor monotonically; never move it backwards, so a
                # resumed/overlapping run cannot rewind indexing progress.
                prior = conn.execute(
                    "SELECT last_slot FROM indexer_cursor WHERE program_id = ?",
                    (program_id,),
                ).fetchone()
                if prior is None or prior["last_slot"] is None or highest[0] >= prior["last_slot"]:
                    conn.execute(
                        """INSERT INTO indexer_cursor(program_id, last_signature, last_slot, updated_at)
                           VALUES (?, ?, ?, ?)
                           ON CONFLICT(program_id) DO UPDATE SET
                             last_signature=excluded.last_signature,
                             last_slot=excluded.last_slot,
                             updated_at=excluded.updated_at""",
                        (program_id, highest[1], highest[0], _now()),
                    )
        return {"transactions_inserted": inserted_tx, "events_inserted": inserted_ev, "cursor": highest}

    def record_error(
        self,
        *,
        program_id: str | None,
        message: str,
        signature: str | None = None,
        slot: int | None = None,
        method: str | None = None,
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO ingest_errors(program_id, signature, slot, method, message, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (program_id, signature, slot, method, message, _now()),
            )

    # --- reads ------------------------------------------------------------
    def cursor(self, program_id: str) -> tuple[str | None, int | None]:
        row = self.conn.execute(
            "SELECT last_signature, last_slot FROM indexer_cursor WHERE program_id = ?",
            (program_id,),
        ).fetchone()
        if row is None:
            return None, None
        return row["last_signature"], row["last_slot"]

    def events(self, *, event_type: str | None = None, order: str = "slot ASC") -> list[sqlite3.Row]:
        sql = "SELECT * FROM tx_events"
        params: list = []
        if event_type:
            sql += " WHERE event_type = ?"
            params.append(event_type)
        sql += f" ORDER BY {order}"
        return list(self.conn.execute(sql, params))

    def transactions(self, *, order: str = "slot ASC") -> list[sqlite3.Row]:
        return list(self.conn.execute(f"SELECT * FROM transactions ORDER BY {order}"))

    def transaction_row(self, signature: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM transactions WHERE signature = ?", (signature,)
        ).fetchone()

    def events_for(self, signature: str) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM tx_events WHERE signature = ? ORDER BY event_index",
                (signature,),
            )
        )

    def swaps(self) -> list[sqlite3.Row]:
        return self.events(event_type="SwapEvent")

    def deposits(self) -> list[sqlite3.Row]:
        return self.events(event_type="DepositEvent")

    def withdrawals(self) -> list[sqlite3.Row]:
        return self.events(event_type="WithdrawClaimed")

    def quote_commits(self) -> list[sqlite3.Row]:
        """Quote lifecycle events (staged + committed), newest first."""
        return [
            row
            for row in self.events(order="slot DESC, event_index DESC")
            if row["event_type"] in ("QuoteCommitted", "QuoteStaged", "QuoteUpdated")
        ]

    def coverage(self) -> dict:
        """Indexed range and timestamps (honest coverage, not a claim of completeness).

        ``first_slot``/``last_slot`` bound the events actually persisted. Anything
        outside that window was not supplied by the RPC provider and must be
        reported as a gap, never filled.
        """
        row = self.conn.execute(
            "SELECT MIN(slot) AS first_slot, MAX(slot) AS last_slot, "
            "MIN(block_time) AS first_block_time, MAX(block_time) AS last_block_time, "
            "COUNT(*) AS transactions FROM transactions"
        ).fetchone()
        events = self.conn.execute(
            "SELECT COUNT(*) AS events, MIN(indexed_at) AS first_indexed_at, "
            "MAX(indexed_at) AS last_indexed_at FROM tx_events"
        ).fetchone()
        return {
            "first_slot": row["first_slot"],
            "last_slot": row["last_slot"],
            "first_block_time": row["first_block_time"],
            "last_block_time": row["last_block_time"],
            "transactions": row["transactions"] or 0,
            "events": events["events"] or 0,
            "first_indexed_at": events["first_indexed_at"],
            "last_indexed_at": events["last_indexed_at"],
        }

    def counts(self) -> dict:
        def count(table: str) -> int:
            return int(self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

        return {
            "schema_version": self.schema_version(),
            "transactions": count("transactions"),
            "events": count("tx_events"),
            "swaps": len(self.swaps()),
            "deposits": len(self.deposits()),
            "withdrawals": len(self.withdrawals()),
            "ingest_errors": count("ingest_errors"),
            "reconciliations": count("reconciliations"),
        }

    def ingest_error_rows(self, limit: int = 50) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM ingest_errors ORDER BY id DESC LIMIT ?", (limit,)
            )
        )

    # --- reconciliation ---------------------------------------------------
    def set_reconciliation(self, signature: str, status: str, details: dict) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO reconciliations(signature, status, details, checked_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(signature) DO UPDATE SET
                     status=excluded.status, details=excluded.details, checked_at=excluded.checked_at""",
                (signature, status, json.dumps(details, sort_keys=True), _now()),
            )

    def get_reconciliation(self, signature: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM reconciliations WHERE signature = ?", (signature,)
        ).fetchone()


def _event_payload(event) -> dict:
    from dataclasses import fields

    data = {"name": type(event).__name__}
    for field in fields(event):
        value = getattr(event, field.name)
        data[field.name] = value.hex() if isinstance(value, (bytes, bytearray)) else value
    return data


def _prop(event, name: str):
    value = getattr(event, name, None)
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    return value
