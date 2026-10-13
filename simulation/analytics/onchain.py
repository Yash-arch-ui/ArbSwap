"""Parse on-chain transactions into indexed protocol events.

This module never infers a swap from balance deltas: it decodes the Anchor
``Program data:`` events the program actually emitted, and carries the real
transaction context (signature, slot, block time, error) alongside them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from simulation.analytics import events as ev

ANCHOR_LOG_PREFIX = ev.ANCHOR_LOG_PREFIX


@dataclass(frozen=True)
class TxRecord:
    signature: str
    slot: int
    block_time: int | None
    err: Any | None
    program_id: str
    events: tuple = field(default_factory=tuple)

    @property
    def success(self) -> bool:
        return self.err is None


def parse_transaction(result: dict, program_id: str) -> TxRecord:
    """Convert a ``getTransaction`` result into a :class:`TxRecord`."""
    if not result or "transaction" not in result:
        raise ValueError("empty transaction result")
    meta = result.get("meta") or {}
    logs = meta.get("logMessages") or []
    signature = result["transaction"]["signatures"][0]
    return TxRecord(
        signature=signature,
        slot=int(result["slot"]),
        block_time=result.get("blockTime"),
        err=meta.get("err"),
        program_id=program_id,
        events=tuple(ev.parse_logs(logs)),
    )
