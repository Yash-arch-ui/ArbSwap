"""Program-event model and Anchor-log parsing (Build Plan §6.5, §9.1).

The indexer consumes the events the on-chain program emits with `#[event]`.
Each is written to the program log as ``Program data: <base64>`` where the
payload is an 8-byte Anchor discriminator ``sha256("event:" + Name)[:8]``
followed by the Borsh-serialised fields.

This module is dependency-free and independent of the simulator:
- :func:`parse_logs` turns a list of program log lines into typed events,
- :func:`to_json`/:func:`from_json` move events to and from JSON lines so a
  replay (or the simulator bridge) can feed the indexer without a validator.

Field order and types mirror the Rust structs in
``vault/program/src/lib.rs`` exactly.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from dataclasses import dataclass, fields, is_dataclass
from pathlib import Path
from typing import Iterable

ANCHOR_LOG_PREFIX = "Program data: "


@dataclass(frozen=True)
class VaultInitialized:
    slot: int
    vault: bytes


@dataclass(frozen=True)
class DepositEvent:
    slot: int
    shares: int
    base_amount: int
    quote_amount: int


@dataclass(frozen=True)
class WithdrawRequested:
    slot: int
    shares: int
    epoch: int


@dataclass(frozen=True)
class WithdrawClaimed:
    slot: int
    shares: int
    base_amount: int
    quote_amount: int


@dataclass(frozen=True)
class QuoteUpdated:
    slot: int
    version: int
    anchor_sqrt_price: int
    depth_mult_bps: int


@dataclass(frozen=True)
class SwapEvent:
    slot: int
    version: int
    side: str  # "buy" (trader buys base) or "sell"
    amount_in: int
    amount_out: int
    fee: int
    # Enriched during reconciliation (§9.1): the mid and the output the quote
    # at the end of the previous slot implied. Not carried on chain.
    mid_at_fill: float = 0.0
    quoted_out: float = 0.0


@dataclass(frozen=True)
class BreakerTripped:
    slot: int


@dataclass(frozen=True)
class BreakerReset:
    slot: int


@dataclass(frozen=True)
class ParamsProposed:
    slot: int
    activate_slot: int


@dataclass(frozen=True)
class ParamsApplied:
    slot: int


@dataclass(frozen=True)
class ProgramInitialized:
    admin: bytes


@dataclass(frozen=True)
class KeeperBonded:
    keeper: bytes
    amount: int
    total: int


@dataclass(frozen=True)
class KeeperSlashed:
    keeper: bytes
    amount: int


@dataclass(frozen=True)
class RewardClaimed:
    keeper: bytes
    base: int
    quote: int


# Rust struct name -> (dataclass, ordered field spec). The discriminator uses the
# Rust struct name (e.g. the conceptual "Swap" event is `SwapEvent`).
_BORSH_ORDER = "order"  # dataclass field order == Borsh field order
EVENT_TYPES: dict[str, type] = {
    cls.__name__: cls
    for cls in (
        VaultInitialized,
        DepositEvent,
        WithdrawRequested,
        WithdrawClaimed,
        QuoteUpdated,
        SwapEvent,
        BreakerTripped,
        BreakerReset,
        ParamsProposed,
        ParamsApplied,
        ProgramInitialized,
        KeeperBonded,
        KeeperSlashed,
        RewardClaimed,
    )
}

_SIDE = {"buy": 0, "sell": 1}
_SIDE_INV = {0: "buy", 1: "sell"}


def discriminator(name: str) -> bytes:
    """Anchor event discriminator: ``sha256("event:" + name)[:8]``."""
    return hashlib.sha256(f"event:{name}".encode()).digest()[:8]


# --- Borsh encoding (used to build synthetic logs in tests) ----------------

class _Writer:
    def __init__(self) -> None:
        self.buf = bytearray()

    def u32(self, value: int) -> None:
        self.buf += struct.pack("<I", value)

    def u64(self, value: int) -> None:
        self.buf += struct.pack("<Q", value)

    def u128(self, value: int) -> None:
        self.buf += value.to_bytes(16, "little")

    def u8(self, value: int) -> None:
        self.buf += struct.pack("<B", value)

    def key(self, value: bytes) -> None:
        assert len(value) == 32
        self.buf += bytes(value)


def encode_log(name: str, **values) -> str:
    """Encode one event as an Anchor ``Program data:`` log line (spec widths)."""
    writer = _Writer()
    for field, kind in _SPEC[name]:
        value = values[field]
        if field == "side":
            writer.u8(_SIDE[value])
        else:
            getattr(writer, kind)(value)
    payload = discriminator(name) + bytes(writer.buf)
    return ANCHOR_LOG_PREFIX + base64.b64encode(payload).decode()


_SPEC: dict[str, tuple[tuple[str, str], ...]] = {
    "VaultInitialized": (("slot", "u64"), ("vault", "key")),
    "DepositEvent": (("slot", "u64"), ("shares", "u64"), ("base_amount", "u64"),
                     ("quote_amount", "u64")),
    "WithdrawRequested": (("slot", "u64"), ("shares", "u64"), ("epoch", "u64")),
    "WithdrawClaimed": (("slot", "u64"), ("shares", "u64"), ("base_amount", "u64"),
                        ("quote_amount", "u64")),
    "QuoteUpdated": (("slot", "u64"), ("version", "u64"), ("anchor_sqrt_price", "u128"),
                     ("depth_mult_bps", "u32")),
    "SwapEvent": (("slot", "u64"), ("version", "u64"), ("side", "u8"),
                  ("amount_in", "u64"), ("amount_out", "u64"), ("fee", "u64")),
    "BreakerTripped": (("slot", "u64"),),
    "BreakerReset": (("slot", "u64"),),
    "ParamsProposed": (("slot", "u64"), ("activate_slot", "u64")),
    "ParamsApplied": (("slot", "u64"),),
    "ProgramInitialized": (("admin", "key"),),
    "KeeperBonded": (("keeper", "key"), ("amount", "u64"), ("total", "u64")),
    "KeeperSlashed": (("keeper", "key"), ("amount", "u64")),
    "RewardClaimed": (("keeper", "key"), ("base", "u64"), ("quote", "u64")),
}


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def take(self, n: int) -> bytes:
        chunk = self.data[self.offset:self.offset + n]
        if len(chunk) != n:
            raise ValueError("event payload truncated")
        self.offset += n
        return chunk

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def u128(self) -> int:
        return int.from_bytes(self.take(16), "little")


def _decode_payload(name: str, reader: _Reader) -> dict:
    values: dict = {}
    for field, kind in _SPEC[name]:
        if kind == "u32":
            values[field] = reader.u32()
        elif kind == "u64":
            values[field] = reader.u64()
        elif kind == "u128":
            values[field] = reader.u128()
        elif kind == "u8":
            values[field] = _SIDE_INV[reader.take(1)[0]]
        elif kind == "key":
            values[field] = reader.take(32)
        else:  # pragma: no cover - guarded by the spec
            raise ValueError(f"unknown field kind {kind!r}")
    return values


def parse_logs(logs: Iterable[str]) -> list:
    """Parse Anchor program logs into events (unknown data lines are ignored)."""
    by_discriminator = {discriminator(name): name for name in EVENT_TYPES}
    events = []
    for line in logs:
        if not line.startswith(ANCHOR_LOG_PREFIX):
            continue
        try:
            payload = base64.b64decode(line[len(ANCHOR_LOG_PREFIX):].strip())
        except (ValueError, base64.binascii.Error):
            continue
        if len(payload) < 8:
            continue
        name = by_discriminator.get(payload[:8])
        if name is None:
            continue
        values = _decode_payload(name, _Reader(payload[8:]))
        events.append(EVENT_TYPES[name](**values))
    return events


# --- JSON lines ------------------------------------------------------------

def _jsonable(event) -> dict:
    data = {"name": type(event).__name__}
    for field in fields(event):
        value = getattr(event, field.name)
        data[field.name] = value.hex() if isinstance(value, (bytes, bytearray)) else value
    return data


def to_json(event) -> dict:
    return _jsonable(event)


def from_json(data: dict):
    name = data["name"]
    cls = EVENT_TYPES[name]
    kwargs = {}
    for field in fields(cls):
        if field.name not in data:
            continue
        value = data[field.name]
        if field.type in ("bytes",) and isinstance(value, str):
            value = bytes.fromhex(value)
        kwargs[field.name] = value
    return cls(**kwargs)


def dump_jsonl(events: Iterable, path: str | Path) -> int:
    path = Path(path)
    count = 0
    with path.open("w") as handle:
        for event in events:
            handle.write(json.dumps(_jsonable(event), sort_keys=True) + "\n")
            count += 1
    return count


def load_jsonl(path: str | Path) -> list:
    events = []
    with Path(path).open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                events.append(from_json(json.loads(line)))
    return events
