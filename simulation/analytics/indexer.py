"""Event store and reconciliation (Build Plan §9.1).

The indexer keeps events ordered by slot and exposes the views the metrics and
dashboard need. Reconciliation attaches the data the on-chain event omits — the
mid at fill and the quoted output — which a live indexer reads from the
`QuoteState` account at the swap slot (§9.1) and which the simulator bridge
supplies directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from simulation.analytics import events as ev
from simulation.analytics.chain import RpcError, SolanaRpc, iter_signatures
from simulation.analytics.onchain import parse_transaction


@dataclass
class EventStore:
    """Events in slot order, with convenience views."""

    events: list = field(default_factory=list)

    def add(self, event) -> None:
        self.events.append(event)

    def by_type(self, cls) -> list:
        return [e for e in self.events if isinstance(e, cls)]

    @property
    def swaps(self) -> list:
        return self.by_type(ev.SwapEvent)

    @property
    def quotes(self) -> list:
        return self.by_type(ev.QuoteUpdated)

    @property
    def deposits(self) -> list:
        return self.by_type(ev.DepositEvent)

    @property
    def withdrawals(self) -> list:
        return self.by_type(ev.WithdrawClaimed)

    @property
    def breakers(self) -> list:
        return self.by_type(ev.BreakerTripped)

    @property
    def max_slot(self) -> int:
        return max((_slot(e) for e in self.events), default=0)

    @property
    def version(self) -> int:
        """Latest quote version seen (0 when no quote has been posted)."""
        return max((e.version for e in self.quotes), default=0)


def _slot(event) -> int:
    return getattr(event, "slot", 0)


def index(events) -> EventStore:
    store = EventStore()
    for event in sorted(events, key=_slot):
        store.add(event)
    return store


def reconcile(swaps: list, mid_at, *, step_seconds: float = 1.0) -> list:
    """Return swaps with ``mid_at_fill`` filled from ``mid_at(second)``.

    ``mid_at`` is the reconciled mid (from `QuoteState` on chain, or the
    simulator's price path in a replay). A swap's slot maps to a second by
    ``step_seconds``; the second is the slot for the archive-scale clock.
    """
    out = []
    for swap in swaps:
        mid = mid_at(int(swap.slot * step_seconds)) or swap.mid_at_fill
        out.append(swap if mid == swap.mid_at_fill else _replace(swap, mid))
    return out


def _replace(swap, mid: float):
    return ev.SwapEvent(
        slot=swap.slot,
        version=swap.version,
        side=swap.side,
        amount_in=swap.amount_in,
        amount_out=swap.amount_out,
        fee=swap.fee,
        mid_at_fill=mid,
        quoted_out=swap.quoted_out,
    )


# --- on-chain indexer (Build Plan §9.1) ------------------------------------

class ChainIndexer:
    """Backfill/resume the on-chain program's transactions into a database.

    The indexer is careful about partial progress: it collects the signatures
    newer than the persisted cursor, processes them oldest-first, and flushes
    each batch atomically. If an RPC call fails mid-range it records the error
    and stops *without* advancing the cursor past the last good transaction, so
    a later run resumes exactly there.
    """

    def __init__(
        self,
        rpc: SolanaRpc,
        db,
        program_id: str,
        *,
        batch_size: int = 25,
        log=print,
    ) -> None:
        self.rpc = rpc
        self.db = db
        self.program_id = program_id
        self.batch_size = max(1, batch_size)
        self.log = log

    def backfill(self, *, from_slot: int | None = None, max_transactions: int | None = None) -> dict:
        program_id = self.program_id
        last_sig, _ = self.db.cursor(program_id)

        collected: list[tuple[int, str]] = []
        stop = False
        for batch in iter_signatures(self.rpc, program_id, before=last_sig):
            for item in batch:
                signature = item["signature"]
                slot = int(item["slot"])
                if last_sig is not None and signature == last_sig:
                    stop = True
                    break
                if from_slot is not None and slot < from_slot:
                    stop = True
                    break
                collected.append((slot, signature))
                if max_transactions is not None and len(collected) >= max_transactions:
                    stop = True
                    break
            if stop:
                break

        collected.sort()  # oldest-first
        processed = 0
        buffer: list = []
        for slot, signature in collected:
            try:
                result = self.rpc.get_transaction(signature)
            except RpcError as error:
                self.db.record_error(
                    program_id=program_id, signature=signature, slot=slot,
                    method="getTransaction", message=str(error),
                )
                self.log(f"indexer: stopping at {signature}: {error}")
                break
            if result is None:
                self.db.record_error(
                    program_id=program_id, signature=signature, slot=slot,
                    method="getTransaction", message="transaction not available yet",
                )
                self.log(f"indexer: stopping at {signature}: transaction not available")
                break
            buffer.append(parse_transaction(result, program_id))
            if len(buffer) >= self.batch_size:
                self.db.ingest_records(program_id, buffer)
                processed += len(buffer)
                buffer = []
        if buffer:
            self.db.ingest_records(program_id, buffer)
            processed += len(buffer)

        return {
            "program_id": program_id,
            "candidates": len(collected),
            "processed": processed,
            "cursor": self.db.cursor(program_id),
        }
