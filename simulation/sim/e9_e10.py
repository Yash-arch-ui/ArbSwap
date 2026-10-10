"""E9 sensitivity and E10 cost studies (Build Plan §8.4, T5.5).

E9 sweeps the tunable parameters the methodology flags as design heuristics
(``docs/FORMULA.md``): the passive-pool fee, the vault fee, and the oracle
latency, across calm / trend / crash paths. It reports E1 and the honest
quote-versus-fill gap for every cell, so a sensitivity (not a tuned optimum) is
all that is claimed.

E10 reports the current measured Solana cost (CU per update/swap from
``docs/SECURITY_CHECKLIST.md`` / ``CostModel``) and the keeper update cadence
that could be sustained against the paper's cost targets. It does **not** invent
a mainnet priority-fee rate; it reports the measured CU and the gas+priority
cost curve at the reference price.
"""

from __future__ import annotations

from simulation.reference.quote_math import QuoteParams
from simulation.sim.costs import CostModel, CU_UPDATE_QUOTE, CU_SWAP
from simulation.sim.experiments import e1_lvr_reduction, run_venues
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import synthetic_series

REGIMES = ("calm", "trend", "crash")
PASSIVE_FEES = (0.0001, 0.0003, 0.0010)
VAULT_FEES_BPS = (1, 3, 10)
LATENCIES = (0.2, 1.0, 4.0)


def e9_sensitivity(
    *,
    length: int = 1_200,
    seed: int = 20261006,
    regimes: tuple[str, ...] = REGIMES,
    passive_fees: tuple[float, ...] = PASSIVE_FEES,
    vault_fees_bps: tuple[int, ...] = VAULT_FEES_BPS,
    latencies: tuple[float, ...] = LATENCIES,
) -> list[dict]:
    """Sweep passive fee, vault fee, and oracle latency; report E1 + gap."""
    rows: list[dict] = []
    for regime in regimes:
        prices = synthetic_series(regime=regime, length=length, seed=seed)
        for passive_fee in passive_fees:
            for vault_fee in vault_fees_bps:
                for latency in latencies:
                    reports = run_venues(
                        prices,
                        params=QuoteParams(),
                        seed=seed,
                        passive_fee=passive_fee,
                        vault_fee_bps=vault_fee,
                        oracle=OracleModel(latency_seconds=latency, seed=seed),
                    )
                    e1 = e1_lvr_reduction(reports)
                    rows.append({
                        "regime": regime,
                        "passive_fee": passive_fee,
                        "vault_fee_bps": vault_fee,
                        "latency_s": latency,
                        "e1": round(e1, 4),
                        "gap_bps": round(reports["ArbSwap"].gap_bps, 4),
                        "fill_rate": round(reports["ArbSwap"].fill_rate, 4),
                    })
    return rows


def e10_cost_summary(*, sol_price: float = 150.0) -> dict:
    """Measured CU and the cost to sustain a keeper cadence."""
    model = CostModel()
    gas_update, prio_update = model.update(sol_price)
    gas_swap, prio_swap = model.swap(sol_price)
    # One update per second (Build Plan §7.1 target <=400 ms) and one slot (0.4 s).
    updates_per_hour = 3_600
    return {
        "cu_update_quote": CU_UPDATE_QUOTE,
        "cu_swap": CU_SWAP,
        "update_gas_quote": round(gas_update, 6),
        "update_priority_quote": round(prio_update, 6),
        "update_total_quote": round(gas_update + prio_update, 6),
        "update_cost_per_hour_quote": round((gas_update + prio_update) * updates_per_hour, 4),
        "swap_total_quote": round(gas_swap + prio_swap, 6),
        "updates_per_hour": updates_per_hour,
        "cu_vs_paper_updates": round(CU_UPDATE_QUOTE / 676.0, 1),
        "cu_vs_paper_swap_floor": round(CU_SWAP / 16_938.0, 1),
        "under_200k_default": CU_SWAP < 200_000 and CU_UPDATE_QUOTE < 200_000,
    }


if __name__ == "__main__":
    rows = e9_sensitivity()
    print("E9 sensitivity (E1 = ArbSwap hedged-PnL improvement over B1):")
    for row in rows:
        print(f"  {row['regime']:6} pf={row['passive_fee']:.4f} "
              f"vf={row['vault_fee_bps']:>2}u lat={row['latency_s']:.1f}s "
              f"E1={row['e1']:+.4f} gap={row['gap_bps']:+.3f} fill={row['fill_rate']:.0%}")
    print("\nE10 cost (SOL=$150):")
    for key, value in e10_cost_summary().items():
        print(f"  {key} = {value}")
    print("\nE8 is blocked offline (needs real Solana-pool quote data); "
          "see docs/ARCHITECTURE.md and docs/SECURITY_CHECKLIST.md.")

def envelope(*, length: int = 600, seed: int = 20261006) -> list[dict]:
    """Item 3e: where ArbSwap wins, ties, or loses vs B1.

    Dimensions: oracle latency, vault fee, and volatility regime. A verdict of
    "win" is E1 > +2%, "tie" is |E1| <= 2%, "lose" is E1 < -2%.
    """
    rows: list[dict] = []
    for regime in REGIMES:
        prices = synthetic_series(regime=regime, length=length, seed=seed)
        for vault_fee in (1, 3, 10):
            for latency in (0.2, 1.0, 4.0):
                reports = run_venues(
                    prices, params=QuoteParams(), seed=seed,
                    vault_fee_bps=vault_fee,
                    oracle=OracleModel(latency_seconds=latency, seed=seed),
                )
                e1 = e1_lvr_reduction(reports)
                verdict = "win" if e1 > 0.02 else ("lose" if e1 < -0.02 else "tie")
                rows.append({
                    "regime": regime, "vault_fee_bps": vault_fee,
                    "latency_s": latency, "e1": round(e1, 4), "verdict": verdict,
                })
    return rows
