"""On-chain cost model for the simulator (Task 1.4).

Every keeper update and every swap is a Solana transaction, so the simulator
charges two things per transaction:

- **gas** - the flat per-signature base fee (5,000 lamports);
- **priority fee** - ``compute_units x priority price``, using the *measured*
  CU figures from ``docs/SECURITY_CHECKLIST.md`` rather than a guess.

Both are denominated in lamports and converted to the quote token (USDC) at the
reference SOL price of the moment, because the vault's base asset is SOL.

``priority_micro_lamports_per_cu`` is a **heuristic**: mainnet priority prices
are set by an auction that no offline study can predict. It is reported, swept
in the sensitivity table, and never presented as a measured quantity.
"""

from __future__ import annotations

from dataclasses import dataclass

LAMPORTS_PER_SOL = 1_000_000_000.0
BASE_FEE_LAMPORTS = 5_000

# Measured on LiteSVM against the built program by
# `vault/program/tests/litesvm_lifecycle.rs::measure_instruction_compute_units`,
# committed to `simulation/data/results/cu.json` (the single source of truth for
# numbers; C1.1). B1 (2026-10-09): `cargo build-sbf` (no idl-build) gives ~48k; `anchor build`
# (idl-build) is ~3k higher (~51k). The historical 48,296 -> 51,296 was a stale
# `.so` (build-method artifact), not a source regression; use scripts/measure_cu.sh.
CU_UPDATE_QUOTE = 48_079
CU_SWAP = 59_162

# Heuristic: a mid-priority keeper lands inside one or two slots most of the
# time, with a thin tail when the network is congested. Probabilities sum to 1.
LANDING_DELAY_SECONDS: tuple[tuple[float, float], ...] = (
    (0.4, 0.55),
    (0.8, 0.25),
    (1.2, 0.12),
    (2.0, 0.05),
    (3.2, 0.03),
)


def landing_delay(rng) -> float:
    """Draw one landing delay (seconds) from :data:`LANDING_DELAY_SECONDS`."""
    draw = rng.random()
    cumulative = 0.0
    for value, probability in LANDING_DELAY_SECONDS:
        cumulative += probability
        if draw <= cumulative:
            return value
    return LANDING_DELAY_SECONDS[-1][0]


@dataclass(frozen=True)
class CostModel:
    """Per-transaction cost in USDC, given the current SOL price."""

    cu_update: int = CU_UPDATE_QUOTE
    cu_swap: int = CU_SWAP
    base_fee_lamports: int = BASE_FEE_LAMPORTS
    priority_micro_lamports_per_cu: float = 1_000.0
    lamports_per_sol: float = LAMPORTS_PER_SOL

    def split(self, compute_units: int, sol_price: float) -> tuple[float, float]:
        """``(gas_quote, priority_quote)`` for one transaction at ``sol_price``."""
        if sol_price <= 0:
            raise ValueError("sol_price must be positive")
        if self.lamports_per_sol <= 0:
            raise ValueError("lamports_per_sol must be positive")
        gas = self.base_fee_lamports / self.lamports_per_sol * sol_price
        micro = compute_units * self.priority_micro_lamports_per_cu
        priority = micro / 1_000_000.0 / self.lamports_per_sol * sol_price
        return gas, priority

    def update(self, sol_price: float) -> tuple[float, float]:
        """``(gas, priority)`` for one ``update_quote`` transaction."""
        return self.split(self.cu_update, sol_price)

    def swap(self, sol_price: float) -> tuple[float, float]:
        """``(gas, priority)`` for one ``swap`` transaction."""
        return self.split(self.cu_swap, sol_price)

    @property
    def update_cu(self) -> int:
        return self.cu_update

    @property
    def swap_cu(self) -> int:
        return self.cu_swap
