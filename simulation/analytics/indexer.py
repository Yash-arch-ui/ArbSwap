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
