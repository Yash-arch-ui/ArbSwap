//! ArbSwap keeper skeleton (Build Plan Section 7).
//!
//! P0: binary exists and builds; the real loop lands in P3:
//!   T3.1 Pyth streaming client + volatility estimators (Build Plan §5.4)
//!        + quote calculator via `arb-math`
//!   T3.2 sender with adaptive priority fee, tight CU limit, retries
//!   T3.3 replay mode producing quotes identical to the simulator
//!
//! Safety: if the keeper cannot update in time, the on-chain quote expires and
//! the vault stops filling (Build Plan §5.12) — failure is safe by design.

fn main() {
    println!("arbswap-keeper skeleton (P0) — see Build Plan Section 7");
    // TODO(P3 T3.1): subscribe to Pyth (Core vs Lazer: docs/ASSUMPTIONS.md A-07)
    // TODO(P3 T3.1): sigma_s/sigma_m EWMA estimators + jump detector with cool-down
    // TODO(P3 T3.2): should_update (move > 0.5 bps, or 10 slots, or regime change)
    // TODO(P3 T3.2): priority fee scaled to urgency; tight compute-budget limit
    // TODO(P3 T3.3): replay mode must match the simulator bit-for-bit
    let _ = arb_math::mul_div_floor(1, 1, 1); // link-check against the math crate
}
