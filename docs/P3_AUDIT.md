# P3_AUDIT.md — Phase 3 (Keeper): idea target vs codebase

Audit of the keeper against the idea documents: **Build Plan §7 (Keeper
specification) and §12 P3**, and **Master Plan §11 P3**. Code audited:
`vault/keeper/src/{lib.rs,main.rs}` (1,638 lines), 16 unit tests, the Python
parity suite (`simulation/sim/test_keeper_parity.py`, 5 tests), and the devnet
run (P2 gate).

## 1. The idea's P3 (verbatim targets)

**Build Plan §12 P3 (weeks 5–7):**
| Task | Target |
|---|---|
| T3.1 | Pyth streaming client; vol estimators; quote calculator via `tq-math` |
| T3.2 | Sender with adaptive priority fee, tight CU limit, retries |
| T3.3 | Replay mode (feeds recorded prices; outputs identical to the simulator) |
| T3.4 | Keeper bond and reward flow |
| **Gate** | keeper-driven quotes on devnet match the simulator within tolerance; keeper-down test shows safe expiry |

**Build Plan §7 (Keeper specification):** §7.1 loop (read Pyth → update vol →
read state → compute quote → `should_update` → priority fee → send → log
metrics); §7.2 failure handling (RPC retry/backoff, **skip on stale/wide
oracle**, reject landed-late, multiple keepers); §7.3 compute budget (explicit
CU limit, **record CU per update**).

**Master Plan §11 P3:** Rust keeper using Pyth; adaptive priority fee; failure
handling; replay mode matching the simulator. Gate: keeper-driven quotes on
devnet match the simulator.

## 2. Reality — task by task

| Task | Status | Evidence |
|---|---|---|
| T3.1 Pyth client | **PARTIAL** | `parse_hermes`, `HermesSource`, `pyth_decimal_to_q64`, `confidence_bps` exist and are unit-tested; the **live loop uses `ureq::get` with no Hermes auth** (Hermes requires an API key since 2026-08) and does **not** post Pyth updates |
| T3.1 vol estimators | **DONE** | `VolatilityState` EWMA + jump, time-normalised for irregular ticks (`update_with_dt`), `ewma_is_time_normalised` |
| T3.1 quote calculator via `tq-math` | **DONE** | `compute_quote` uses `arb-math`; two-sided ladder (H1); used to post a real devnet `update_quote` in the P2 gate |
| T3.2 sender (priority fee, CU limit, retries) | **DONE (offline)** | `adaptive_priority_fee`, `MAX_UPDATE_COMPUTE_UNITS = 80_000`, `LiveSender` (fresh blockhash + re-sign per attempt), `build_update_quote_transaction` |
| T3.3 replay mode | **DONE** | `replay <csv>`; `KeeperCore::step` shared by replay and live (H6); `test_keeper_parity.py` (5) + `keeper_core_is_deterministic` |
| T3.4 keeper bond / reward | **PARTIAL (program-side only)** | on-chain `bond_keeper`/`claim_keeper_reward`/`slash_keeper`/`unbond_keeper` are tested; the **keeper client has no bond/reward/slash calls** |
| §7.2 skip on stale/wide | **NOT DONE** | `parse_hermes` does not filter staleness/confidence (`HermesSource::latest` doc claims it, code does not); the program rejects them on-chain instead |
| §7.2 RPC retry / landed-late | **DONE** | live loop retries next tick; `LiveSender` bounded retries; program rejects non-monotonic slots |
| §7.2 multiple keepers | **NOT DONE** | MVP allowlists `config.keeper`; no competing keepers |
| §7.3 CU limit set | **DONE** | `MAX_UPDATE_COMPUTE_UNITS` set in the ComputeBudget |
| §7.3 record CU per update | **NOT DONE** | the live loop logs only "update landed slot=…"; CU is measured in LiteSVM tests, not logged live |
| **Gate: live keeper on devnet** | **NOT DONE** | the P2 devnet loop posted `update_quote` from the **e2e client** using keeper math, but the **keeper binary's live loop was never run** |
| **Gate: keeper-down safe expiry** | **DONE** | `keeper_outage_lets_the_quote_expire` (LiteSVM) |

## 3. Idea-vs-reality matrix

| Idea element | Promised | Reality | Gap |
|---|---|---|---|
| Streaming Pyth client | read Pyth continuously | parse + Hermes source exist; live loop fetches without auth and never posts updates | **Hermes API-key auth + Pyth update posting missing** |
| Volatility-aware quoting | EWMA + jump | implemented, time-normalised | none |
| Quote via shared math | same code as program | `compute_quote` reused; proved on devnet | none |
| Adaptive priority fee | scale with urgency | implemented | not measured live |
| Tight CU limit | explicit budget | 80k set | CU not logged live |
| Replay == simulator | identical outputs | parity + determinism tests | none |
| Bonded keeper | bond/reward/slash | program-side complete + tested | keeper client doesn't bond/claim |
| Skip stale/wide | skip bad ticks | not filtered in keeper | relies on program rejection |
| Multiple keepers | open competition | allowlist MVP | P5 |
| Gate: devnet keeper | quotes match sim | e2e posted via keeper math; **live binary not run** | **run the live keeper** |
| Gate: safe expiry | keeper-down → expiry | tested | none |

## 4. What is LEFT for P3 (ordered)

1. **Hermes auth (BLOCKER).** Add the `Authorization: Bearer <PYTH_API_KEY>`
   header (key from env) to the live loop; otherwise it cannot fetch prices.
2. **Pyth update posting (BLOCKER).** The live keeper must supply a fresh
   `PriceUpdateV2` per update: either in-band (receiver `update_price_feeds` CPI,
   as `scripts/devnet/post_pyth.ts` does off-chain) or a sponsored price-feed
   account updated by a separate crank. Today the live loop takes a fixed
   `price_update` account that goes stale after `max_staleness_seconds`.
3. **Run the live keeper on devnet** for 10–15 min at low cadence; record update
   success rate, landing latency, CU, failures (the actual P3 gate).
4. **Skip stale/wide in the keeper** (`PriceSource::latest` should return
   `Ok(None)` when `publish_time` is too old or `conf/price` exceeds a bound) so
   it does not send doomed updates.
5. **Log CU per update** in the live loop (metric from §7.3).
6. **Keeper client bond/reward** (`bond_keeper`, `claim_keeper_reward`) — or
   document that bonding is done by an ops script; T3.4 is otherwise met.
7. **Open keeper network** (multiple keepers) — roadmap P5, not P3.

## 5. Gate verdict

**P3 gate: PARTIAL.** The math, replay, sender, and keeper-down expiry are
complete and tested; the **live keeper path is not functional against current
Pyth/Hermes** (no auth, no update posting) and the **live devnet run is not
done**. The devnet `update_quote` in the P2 gate used the keeper's quote math but
was submitted by the e2e client, not the keeper binary.

**Bottom line:** P3's *offline* half (estimators, quote calculator, replay,
parity, sender) is done; the *online* half (streaming Pyth with auth, posting
fresh updates, running live on devnet, CU/latency metrics) is what remains.
