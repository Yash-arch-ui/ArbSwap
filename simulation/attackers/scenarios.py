"""Adversarial scenario bots (Build Plan §12 P5, T5.1; E7).

Each bot takes an attacker's point of view and drives the verified simulator
(``simulation.sim``) with an adversarially chosen oracle, keeper cadence, or order
flow, then reports the containment metrics. The account/authority-level attacks
(stale oracle account, wrong feed, anchored-level / bad-tick, Token-2022,
donation, phantom-liquidity warm-up) are proven on-chain by the LiteSVM suite in
``vault/program/tests``; the scenario dict for those bots records the on-chain
test that contains them (see ``docs/THREAT_MODEL.md``).

Every bot returns a ``dict`` with ``scenario``, ``mitigation``, ``report`` (the
per-venue metrics) and ``verdict`` (the containment claim). The tests in
``attackers/tests/test_e7.py`` assert the structural guarantees that hold by
construction: the honest vault's quote-versus-fill gap is ~0, the no-honesty
ablation shows a positive gap, and a dead keeper stops fills once quotes expire.
"""

from __future__ import annotations

from dataclasses import dataclass

from simulation.reference.quote_math import QuoteParams
from simulation.sim.experiments import RunConfig, run_venues
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.oracle import OracleModel
from simulation.sim.price_source import Regime, synthetic_series

# On-chain LiteSVM tests that contain the account/authority-level attacks. Kept
# in one place so the E7 report and THREAT_MODEL stay in sync with the suite.
ON_CHAIN_CONTAINMENT = {
    "stale_oracle": "lifecycle::pyth_verification_rejects_untrusted_or_stale_updates",
    "bad_tick": "lifecycle::level_far_from_the_anchor_is_rejected"
    " / reservation_outside_the_inventory_band_is_rejected",
    "phantom_liquidity": "lifecycle::second_deposit_reuses_the_ticket_and_pulls_only_what_is_needed"
    " (warm-up) + request_withdraw_rejects_a_foreign_share_account",
    "keeper_down": "lifecycle::keeper_outage_lets_the_quote_expire",
    "sandwich": "lifecycle::swap_enforces_slippage_version_and_size",
}


@dataclass(frozen=True)
class Scenario:
    name: str
    mitigation: str
    regime: Regime = "trend"
    length: int = 3_600
    seed: int = 20261006
    oracle_latency: float = 1.0
    keeper_interval: float = 1.0
    informed: InformedFlow = InformedFlow()
    noise: NoiseFlow | None = None

    def _oracle(self) -> OracleModel:
        return OracleModel(latency_seconds=self.oracle_latency, seed=self.seed)

    def run(self) -> dict:
        prices = synthetic_series(regime=self.regime, length=self.length, seed=self.seed)
        reports = run_venues(
            prices,
            params=QuoteParams(),
            config=RunConfig(seed=self.seed),
            oracle=self._oracle(),
            informed=self.informed,
            noise=self.noise or NoiseFlow(seed=self.seed),
            seed=self.seed,
            keeper_update_interval_seconds=self.keeper_interval,
            record_quotes=False,
        )
        arbs = reports["ArbSwap"]
        passive = reports["B1_passive"]
        b4 = reports["B4_no_honesty"]
        return {
            "scenario": self.name,
            "mitigation": self.mitigation,
            "report": {
                "ArbSwap_hedged_pnl": arbs.hedged_pnl,
                "ArbSwap_gap_bps": arbs.gap_bps,
                "ArbSwap_markout_2s_bps": arbs.markout_2s_bps,
                "ArbSwap_fill_rate": arbs.fill_rate,
                "ArbSwap_trades": arbs.trades,
                "B1_hedged_pnl": passive.hedged_pnl,
                "B1_markout_2s_bps": passive.markout_2s_bps,
                "B4_gap_bps": b4.gap_bps,
                "B4_markout_2s_bps": b4.markout_2s_bps,
                "ArbSwap_quote_updates": arbs.update_count,
            },
        }


# --- E7 bots ----------------------------------------------------------------

def stale_feed() -> Scenario:
    return Scenario(
        name="stale-feed (oracle frozen 60s)",
        mitigation="staleness/confidence widening + expiry (S-01); on-chain: "
        + ON_CHAIN_CONTAINMENT["stale_oracle"],
        regime="crash",
        oracle_latency=60.0,
        informed=InformedFlow(fee_bps=1.0, max_size=5_000.0),
    )


def bad_tick() -> Scenario:
    return Scenario(
        name="bad-tick / volatility spike",
        mitigation="jump detection, spread floor, depth throttle; on-chain "
        "anchor-step guard (S-02): " + ON_CHAIN_CONTAINMENT["bad_tick"],
        regime="crash",
        oracle_latency=1.0,
        informed=InformedFlow(fee_bps=0.5, max_size=5_000.0),
    )


def sandwich() -> Scenario:
    return Scenario(
        name="sandwich / pick-off around repricing",
        mitigation="versioned quotes + min_out (S-03): "
        + ON_CHAIN_CONTAINMENT["sandwich"],
        regime="trend",
        noise=NoiseFlow(arrival_rate=0.8, mean_size=150.0, seed=20261006),
        informed=InformedFlow(fee_bps=0.5, max_size=8_000.0),
    )


def phantom_liquidity() -> Scenario:
    return Scenario(
        name="phantom-liquidity (warm-up / depth cap)",
        mitigation="warm-up + epoch queue + utilization cap (S-04): "
        + ON_CHAIN_CONTAINMENT["phantom_liquidity"],
        regime="crash",
        informed=InformedFlow(fee_bps=0.5, max_size=20_000.0),
    )


def keeper_down() -> Scenario:
    return Scenario(
        name="keeper-down (no updates after init)",
        mitigation="quote expiry stops fills + breaker (S-05): "
        + ON_CHAIN_CONTAINMENT["keeper_down"],
        regime="trend",
        keeper_interval=1e9,
    )


def keeper_alive() -> Scenario:
    """Control for ``keeper_down``: same path, keeper constantly refreshing."""
    return Scenario(
        name="keeper-alive (control)",
        mitigation="control run for S-05",
        regime="trend",
        keeper_interval=1.0,
    )


def toxic_flow() -> Scenario:
    return Scenario(
        name="adaptive toxic flow (high-frequency informed)",
        mitigation="spread floor + depth throttle + expiry (S-06)",
        regime="crash",
        noise=NoiseFlow(arrival_rate=0.5, mean_size=120.0, seed=20261006),
        informed=InformedFlow(fee_bps=0.25, max_size=15_000.0),
    )


def oracle_update_sandwich() -> Scenario:
    return Scenario(
        name="sandwich around oracle update",
        mitigation="versioned quotes + min_out (S-07)",
        regime="crash",
        oracle_latency=0.2,
        noise=NoiseFlow(arrival_rate=0.6, mean_size=100.0, seed=20261006),
        informed=InformedFlow(fee_bps=0.5, max_size=10_000.0),
    )


SCENARIOS = [
    stale_feed,
    bad_tick,
    sandwich,
    phantom_liquidity,
    keeper_alive,
    keeper_down,
    toxic_flow,
    oracle_update_sandwich,
]