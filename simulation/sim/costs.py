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

# Measured on LiteSVM against the built program (docs/SECURITY_CHECKLIST.md).
# Re-measured 2026-10-07 after the D-07 bond account was added to `update_quote`
# (the extra unchecked account costs ~5k CU even on the allowlist path) and the
# F-04 anchor ladder changed the swap walk. The swap CU is ladder-dependent.
CU_UPDATE_QUOTE = 17_962
CU_SWAP = 71_518

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
