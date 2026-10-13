"""Decode the deployed program's account layouts for live snapshots.

Offsets mirror ``vault/program/src/lib.rs`` exactly (Anchor 8-byte
discriminator first). Base64 account data is read via :class:`SolanaRpc`; these
are read-only decodes with no signing path.
"""

from __future__ import annotations

import base64
import struct

VAULT_SIZE = 8 + 32 * 7 + 8 * 9 + 2
QUOTE_STATE_SIZE = 8 + 8 * 6 + 16 * 2 + 4 * 5 + 16 + 8 + 4 + 16 + 8 + 16 + (4 + 4 + 16 + 16 + 16) * 6 * 2 + 1 + 16


def _b64(value: dict) -> bytes:
    data = value.get("data")
    if isinstance(data, list):
        return base64.b64decode(data[0])
    raise ValueError("account data not base64")


def encode_base58(raw: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = alphabet[rem] + out
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * pad + out


def _key(data: bytes, offset: int) -> str:
    return encode_base58(data[offset:offset + 32])


def decode_vault(data: bytes) -> dict:
    return {
        "admin": _key(data, 8),
        "base_mint": _key(data, 40),
        "quote_mint": _key(data, 72),
        "base_reserve": _key(data, 104),
        "quote_reserve": _key(data, 136),
        "share_mint": _key(data, 168),
        "share_lock": _key(data, 200),
        "total_shares": struct.unpack_from("<Q", data, 232)[0],
        "insurance_base": struct.unpack_from("<Q", data, 240)[0],
        "insurance_quote": struct.unpack_from("<Q", data, 248)[0],
        "keeper_base": struct.unpack_from("<Q", data, 256)[0],
        "keeper_quote": struct.unpack_from("<Q", data, 264)[0],
        "protocol_base": struct.unpack_from("<Q", data, 272)[0],
        "protocol_quote": struct.unpack_from("<Q", data, 280)[0],
        "epoch": struct.unpack_from("<Q", data, 288)[0],
        "epoch_start": struct.unpack_from("<Q", data, 296)[0],
        "status": data[304],
    }


def decode_quote_state(data: bytes) -> dict:
    def u128(offset: int) -> int:
        return int.from_bytes(data[offset:offset + 16], "little")

    return {
        "version": struct.unpack_from("<Q", data, 8)[0],
        "update_slot": struct.unpack_from("<Q", data, 16)[0],
        "expiry_slot": struct.unpack_from("<Q", data, 24)[0],
        "anchor_sqrt_price": u128(32),
        "p_res_sqrt": u128(48),
        "half_spread_bps": struct.unpack_from("<I", data, 64)[0],
        "ask_extra_bps": struct.unpack_from("<I", data, 68)[0],
        "bid_extra_bps": struct.unpack_from("<I", data, 72)[0],
        "depth_mult_bps": struct.unpack_from("<I", data, 76)[0],
        "oracle_publish_time": struct.unpack_from("<q", data, 104)[0],
        "oracle_conf_bps": struct.unpack_from("<I", data, 112)[0],
        "oracle_price": u128(116),
        # S2-19: authoring keeper, appended after `bump` (offset 845). Existing
        # offsets above are unchanged by the additive migration.
        "keeper": _key(data, 845) if len(data) >= 877 else None,
    }


def decode_config(data: bytes) -> dict:
    return {
        "keeper": _key(data, 40),
        "treasury": _key(data, 72),
        "fee_bps": struct.unpack_from("<H", data, 136)[0],
        "min_liquidity": struct.unpack_from("<Q", data, 144)[0],
        "warmup_slots": struct.unpack_from("<Q", data, 152)[0],
        "epoch_slots": struct.unpack_from("<Q", data, 160)[0],
        "expiry_slots": struct.unpack_from("<Q", data, 176)[0],
        "max_staleness_seconds": struct.unpack_from("<q", data, 184)[0],
        "max_conf_bps": struct.unpack_from("<I", data, 192)[0],
        "max_quote_size": struct.unpack_from("<Q", data, 212)[0],
        "utilization_max_bps": struct.unpack_from("<I", data, 224)[0],
        "flow_window_slots": struct.unpack_from("<Q", data, 264)[0],
        "max_window_flow_bps": struct.unpack_from("<I", data, 272)[0],
    }


def decode_token_amount(data: bytes) -> int:
    """SPL Token account ``amount`` (u64 at offset 64)."""
    return struct.unpack_from("<Q", data, 64)[0]


def price_from_sqrt_q64(sqrt_q64: int) -> float:
    """Q64.64 sqrt price -> float price (quote atoms per base atom)."""
    return (sqrt_q64 * sqrt_q64) / float(1 << 64) / float(1 << 64)


def human_price(price_raw: float, base_decimals: int, quote_decimals: int) -> float:
    return price_raw * (10 ** (base_decimals - quote_decimals))


def read_protocol_snapshot(rpc, vault: str, quote_state: str, config: str) -> dict:
    vault_value = rpc.get_account_info(vault)
    quote_value = rpc.get_account_info(quote_state)
    config_value = rpc.get_account_info(config)
    snapshot: dict = {"vault": None, "quote_state": None, "config": None}
    if vault_value:
        snapshot["vault"] = decode_vault(_b64(vault_value))
    if quote_value:
        snapshot["quote_state"] = decode_quote_state(_b64(quote_value))
    if config_value:
        snapshot["config"] = decode_config(_b64(config_value))
    return snapshot
