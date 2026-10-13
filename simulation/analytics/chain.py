"""Minimal, dependency-free Solana JSON-RPC client (Build Plan §9.1).

Used by the on-chain indexer and the reconciliation command. Only the read
methods the indexer needs are implemented; there is no signing path here so this
module can never move assets. Transient failures (HTTP 429/5xx, timeouts,
JSON-RPC errors) are retried with exponential backoff and surface as
:class:`RpcError` after the budget is exhausted — callers must persist an
ingest error rather than silently skip a range.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterable

DEFAULT_URL = "https://api.devnet.solana.com"


class RpcError(RuntimeError):
    """A JSON-RPC call failed after exhausting retries."""

    def __init__(self, method: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(f"{method}: {message}")
        self.method = method
        self.retryable = retryable


@dataclass
class SolanaRpc:
    url: str = DEFAULT_URL
    timeout: float = 30.0
    retries: int = 4
    backoff: float = 0.5
    sleep: Callable[[float], None] = time.sleep

    def call(self, method: str, params: list) -> Any:
        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        ).encode()
        last: str = "unknown error"
        for attempt in range(self.retries):
            request = urllib.request.Request(
                self.url, data=body, headers={"content-type": "application/json"}
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = json.loads(response.read().decode())
            except urllib.error.HTTPError as error:  # 429 / 5xx are retryable
                last = f"http {error.code}"
                if error.code not in (408, 429, 500, 502, 503, 504):
                    raise RpcError(method, last, retryable=False) from error
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last = str(error)
            else:
                if "error" in payload:
                    last = json.dumps(payload["error"])
                    # -32600..-32602 are malformed-request errors: do not retry.
                    code = payload["error"].get("code", 0)
                    if -32602 <= code <= -32600:
                        raise RpcError(method, last, retryable=False)
                else:
                    return payload.get("result")
            if attempt + 1 < self.retries:
                self.sleep(self.backoff * (2**attempt))
        raise RpcError(method, last)

    # --- read helpers -----------------------------------------------------
    def get_slot(self, commitment: str = "confirmed") -> int:
        return int(self.call("getSlot", [{"commitment": commitment}]))

    def get_signatures_for_address(
        self,
        address: str,
        *,
        limit: int = 1000,
        before: str | None = None,
        until: str | None = None,
        commitment: str = "confirmed",
    ) -> list[dict]:
        options: dict[str, Any] = {"limit": min(limit, 1000), "commitment": commitment}
        if before:
            options["before"] = before
        if until:
            options["until"] = until
        result = self.call("getSignaturesForAddress", [address, options])
        return list(result or [])

    def get_transaction(self, signature: str, commitment: str = "confirmed") -> dict | None:
        return self.call(
            "getTransaction",
            [
                signature,
                {
                    "encoding": "json",
                    "maxSupportedTransactionVersion": 0,
                    "commitment": commitment,
                },
            ],
        )

    def get_account_info(self, address: str, commitment: str = "confirmed") -> dict | None:
        result = self.call("getAccountInfo", [address, {"encoding": "base64", "commitment": commitment}])
        if not result:
            return None
        return result.get("value")


def iter_signatures(
    rpc: SolanaRpc,
    address: str,
    *,
    before: str | None = None,
    until: str | None = None,
    page: int = 1000,
) -> Iterable[list[dict]]:
    """Yield pages of signatures newest-first, stopping at ``until`` if given."""
    cursor = before
    while True:
        batch = rpc.get_signatures_for_address(
            address, limit=page, before=cursor, until=until
        )
        if not batch:
            return
        yield batch
        if len(batch) < page:
            return
        cursor = batch[-1]["signature"]
