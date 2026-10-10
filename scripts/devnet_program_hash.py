#!/usr/bin/env python3
"""P3 - compare the deployed devnet program bytes with a local build.

Read-only (no keypair). Fetches the upgradeable-loader `ProgramData` account for
a program id, strips the loader header, sha256-hashes the ELF, and compares it
with a local `.so`. Used to prove whether the deployed program equals the exact
HEAD build before/after a redeploy.

Run: ``.venv/bin/python scripts/devnet_program_hash.py \
        --program-id CCR33kX4Q9iucvgN4kRga2txmtu32vxy3bXpKyxPdBQx \
        --rpc https://api.devnet.solana.com --so target/deploy/arbswap.so``
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import urllib.request
from pathlib import Path

# UpgradeableLoaderState::ProgramData header:
#   u32 enum tag + u64 slot + u8 Option + 32-byte authority (Some) = 45 bytes.
# A None authority is 44 bytes; we detect by checking both candidate ELF headers.
ELF_MAGIC = b"\x7fELF"
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = _B58[rem] + out
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * pad + out


def _rpc(url: str, method: str, params: list) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def program_data_address(program_id: str, rpc: str) -> tuple[str, str | None]:
    result = _rpc(rpc, "getAccountInfo",
                  [program_id, {"encoding": "base64"}])["result"]["value"]
    if result is None:
        raise SystemExit("program account not found")
    owner = result["owner"]
    data = base64.b64decode(result["data"][0])
    # Program account: u32 tag + programdata pubkey.
    programdata = _b58encode(bytes(data[4:36]))
    return programdata, owner


def fetch_elf(programdata: str, rpc: str) -> bytes:
    result = _rpc(rpc, "getAccountInfo",
                  [programdata, {"encoding": "base64"}])["result"]["value"]
    data = base64.b64decode(result["data"][0])
    for header in (45, 44, 13, 12):  # Some/None authority variants
        if data[header:header + 4] == ELF_MAGIC:
            return data[header:]
    raise SystemExit("could not locate ELF header in ProgramData account")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--program-id", required=True)
    ap.add_argument("--rpc", default="https://api.devnet.solana.com")
    ap.add_argument("--so", type=Path, default=Path("target/deploy/arbswap.so"))
    args = ap.parse_args()

    programdata, owner = program_data_address(args.program_id, args.rpc)
    elf = fetch_elf(programdata, args.rpc)
    chain_hash = hashlib.sha256(elf).hexdigest()
    print(f"program_id     {args.program_id}")
    print(f"owner          {owner}")
    print(f"programdata    {programdata}")
    print(f"on-chain ELF   {len(elf)} bytes sha256={chain_hash}")

    if args.so.exists():
        local = args.so.read_bytes()
        local_hash = hashlib.sha256(local).hexdigest()
        print(f"local {args.so}  {len(local)} bytes sha256={local_hash}")
        print("MATCH" if local_hash == chain_hash else "MISMATCH — deployed != this build")
    else:
        print(f"local {args.so} not found")


if __name__ == "__main__":
    main()
