# ArbSwap Decentralization Audit & Protocol Redesign Plan (S2-17)

Status: **audit / design only — no on-chain changes, no transactions, no deployments.**
Program: `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` (Solana **Devnet**).

This document is grounded in the actual source (`vault/program/src/lib.rs`,
`vault/keeper/src/*`, `scripts/devnet/*`, `app/src/*`, `simulation/analytics/*`) and
in independently reread Devnet state. Where a claim is a hypothesis from the prior
incident report, it is labelled and verified or refuted below.

---

## 0. Independent state verification (this audit)

All reads performed via public Devnet RPC (`https://api.devnet.solana.com`); no
transactions were sent.

| Item | Verified value | How |
|---|---|---|
| Program id | `2mwpYHpZ…hyiNm` | `Anchor.toml:9`, program account |
| ProgramData | `4156VC8Vzc8wQDqtLe9rdRHtRj9UpRysp2uBTNGW93Mh` | RPC `getAccountInfo` |
| ProgramData len / slot | `739701` / `510388097` | RPC header decode |
| **Upgrade authority** | **`ddGs6hk5E4oPzSnwFfX4pD4DDhDTLTwRddv1VQym7bH`** | RPC header decode (Option=Some) |
| Local build vs on-chain | **MATCH** (`scripts/devnet_program_hash.py`, sha256 `51844eb4…bd33`) | read-only |
| Vault | `8yvFBv9…82XPt`, status `Active (0)` | RPC decode |
| Config | `ErVDFAH…Eo2aT` | RPC decode |
| `config.keeper` | `8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH` | RPC decode |
| `config.min_bond` | **`0`** ⇒ allowlist mode | RPC decode |
| `config.admin` | `8R3VDePS…GCQSH` (= keeper wallet) | RPC decode |
| QuoteState | `5MsGbdHv…TYAgG`, **version 18**, expiry 510407830 (expired) | RPC decode |
| Reserves | 0.313621726 WSOL + 37.75 USDC | token accounts |
| `expiry_slots / max_staleness / max_conf` | `10 / 2s / 10bps` | RPC decode |
| `max_anchor_step_bps / max_anchor_dev_bps / max_update_slot_age` | `50 / 25 / 25` | RPC decode |

QuoteState is **still version 18**; the last two tasks did not change it.

> The two keeper paths and the frontend do not share a private backend: there is
> **no hosted service in the repository**. The only secret is a gitignored
> `PYTH_API_KEY` in `.env` plus operator keypair *paths* outside the repo.

---

## 1. Decentralization assessment (summary)

| Layer | Verdict |
|---|---|
| Core AMM/quote/swap math | Permissionless on-chain |
| Deposits / withdrawals / claims / epoch crank | Permissionless on-chain |
| Emergency **trip** breaker | Permissionless on-chain |
| **Quote maintenance** | **Permissioned on-chain** (allowlist because `min_bond=0`) |
| **Quote recovery after a price gap** | **Blocked — no path exists for anyone** |
| Swap execution | Permissionless |
| Frontend | Off-chain client, no backend, but **one hardcoded RPC** |
| Indexer / dashboards | Optional local tooling (SQLite/static files) |
| Oracle | External (Pyth) + Solana/Wormhole |
| **Program upgrades** | **Single hot key `ddGs6hk5…`** |
| Parameter governance / reset breaker / slash / fee claims | Single `admin` key `8R3V…` |

ArbSwap is **not decentralised today**: quoting and every recovery path depend on
one key, and the upgrade authority is a single hot key. The contracts for user
funds (deposit/withdraw) are permissionless and status-independent, which is a
real strength.

---

## 2. Dependency map

Classification: **P**=permissionless on-chain, **Q**=permissioned on-chain,
**O**=off-chain operational, **X**=external data/protocol, **C**=optional convenience.

| Operation | Who can trigger | Required key/process | Single-operator can censor/halt? | Permissionless? | External dep | 1 h outage | 1 d outage | indefinite | Class |
|---|---|---|---|---|---|---|---|---|---|
| Oracle acquisition | anyone (Pyth) | Pyth publisher + Hermes | Indirectly (publisher) | Yes (post is permissionless) | Pyth/Wormhole | quotes fail freshness | stale quotes | no fresh quotes | X |
| Quote update (`update_quote`/`stage`/`commit`) | `config.keeper` only (`min_bond=0`) at `lib.rs:447-452` and `lib.rs:1415-1440` | keeper wallet `8R3V…` | **Yes** | **No** | RPC | quote expires (~4 s) | stale | dead vault | Q |
| Anchor recovery after gap | **nobody** (see §4) | — | — | **No** | — | dead | dead | dead | — |
| Swap execution | any trader | none | No | **Yes** `lib.rs:680` | RPC | unavailable | unavailable | unavailable | P (needs RPC) |
| Deposit | any user | none | No | **Yes** `lib.rs:153` | RPC | unavailable | unavailable | unavailable | P |
| Request/claim withdraw | any user | none (`request_withdraw` `lib.rs:302` has **no status check**) | No | **Yes** | RPC | unavailable | unavailable | unavailable | P |
| Epoch crank | anyone (no signer) | none | No | **Yes** `lib.rs:330` | RPC | delayed | delayed | claims stalled | P |
| Trip breaker | anyone (no signer) | none | No | **Yes** `lib.rs:932` | RPC | — | — | — | P |
| Reset breaker | admin | `8R3V…` | **Yes** | **No** `lib.rs:960` | — | vault stays paused | paused | paused | Q |
| Wind-down | admin | `8R3V…` | Yes | No `lib.rs:975` | — | — | — | new ops halted | Q |
| Fee claims | admin (timelocked) | `8R3V…` | Yes | No `lib.rs:1307,1333` | — | delay | delay | fees stuck | Q |
| Slash keeper | admin | `8R3V…` | Yes | No `lib.rs:1202` | — | — | — | keeper risk | Q |
| Set/apply params | admin (timelock 216 000 slots) | `8R3V…` | Yes | No `lib.rs:986,1010` | — | delay | delay | params frozen | Q |
| Admin rotation | admin → successor (timelock) | both | Yes | No `lib.rs:1064,1083` | — | — | — | — | Q |
| **Program upgrade** | upgrade authority | `ddGs6hk5…` | **Yes (absolute)** | **No** | — | — | — | code can change | Q |
| Frontend serving | anyone who builds it | public RPC | No | Yes | RPC | UI degraded | UI degraded | UI dead | O |
| Historical/indexer data | anyone | local SQLite + RPC | No | Yes | RPC | — | — | local only | C |

---

## 3. Keeper eligibility — root cause (verified)

`require_keeper_authorized` (`lib.rs:1415-1440`) and the inlined check in
`update_quote` (`lib.rs:447-486`) branch on `config.min_bond`:

```rust
if config.min_bond == 0 {                       // lib.rs:1421
    require!(keeper == &config.keeper, ErrorCode::NotKeeper);   // lib.rs:1422
    return Ok(());
}
// else: derive [b"keeper", vault, keeper], require effective bond >= min_bond
```

The deployed config has `min_bond = 0`, so **quoting is an exact-equality allowlist
to `config.keeper`**. The permissionless bonded-keeper path exists in code
(`bond_keeper` `lib.rs:1124` is permissionless) but is **dormant** until
`min_bond > 0`, which can only be set by `initialize_vault` (immutable) or the
timelocked admin `set_params`→`apply_params` (`lib.rs:1043`).

Gaps even in the bonded path:
- `claim_keeper_reward` (`lib.rs:1252-1256`) still requires `keeper == config.keeper`,
  so bonded keepers can quote but only the allowlisted address is paid.
- `slash_keeper` (`lib.rs:1202`) is admin-only and can slash up to the full bond to
  `insurance_quote`; there is no on-chain slashing criterion — the admin decides.
  A bond is therefore **custodial risk**, not a trust-minimised guarantee.

---

## 4. Anchor validation & the liveness deadlock (exact arithmetic)

### 4.1 Exact on-chain conditions

`validate_quote_update` (`lib.rs:1448-1686`) enforces, per update:

1. **Step (in √P space)** — `lib.rs:1508-1515`:
   `|x − x_old| · 10 000 ≤ x_old · max_anchor_step_bps`, where `x` is
   `update.anchor_sqrt_price` (Q64.64).
2. **Deviation (in P space)** — `lib.rs:1559-1564`:
   `|price_from_sqrt(x) − P_oracle| · 10 000 ≤ P_oracle · max_anchor_dev_bps`.

`price_from_sqrt(s) = floor(s² / 2⁶⁴)` (`vault/math/src/fixed.rs:100-102`).
`P_oracle` is the Pyth value normalized to token units:
`pyth_price_q64(p,e)` (`lib.rs:2534`) then `// 10^(base−quote)` (`lib.rs:2555`).

The guard is on the **square root**, so a step of `k` bps in √P is `≈ 2k` bps in
P. This is the crux the earlier report missed.

### 4.2 Results (integer-exact, from live state)

Previous committed anchor: `x_old = 6036613448307627517` →
`P_old = 1975454409660514979` (`107.0896 USDC/SOL`).

Step interval (k=50): `S = floor(x_old·50/10000) = 30183067241538137`
→ `x ∈ [6006430381066089380, 6066796515549165654]`
→ **price ∈ [105.99, 108.16] USDC/SOL**.

**a) S2-16B reported sample (Pyth ≈ 108.272).**
Dev interval (d=25) price `[108.001, 108.543]` ⇒ ∩ with step `[105.99, 108.16]`
= **`[108.001, 108.16]` — NON-EMPTY.** The reported "disjoint bands" were an
artefact of applying the 0.5 % step to price instead of √price. **At the reported
price, a valid anchor existed** (`x ∈ [6062255751796165329, 6066796515549165654]`).
The keeper failed only because it proposes the *full jump* `x = sqrt(P_oracle)`
(`vault/keeper/src/lib.rs:515`) and never clamps (see §5). *The deadlock hypothesis
is refuted for the reported sample.*

**b) Current live sample (Pyth ≈ 108.566).**
Dev price `[108.297, 108.836]`; step price top `108.16` ⇒
**∩ = ∅ (DISJOINT).** Bridgeable max gap
`((1+0.005)²/(1−0.0025) − 1) = +1.256 %`; current `(P_oracle−P_old)/P_old =
+1.378 %`. **The deadlock is real for the current state.**
Smallest single-parameter changes that restore an intersection:
- `max_anchor_step_bps` **50 → 57**, or
- `max_anchor_dev_bps` **25 → 38**.
(Exact, via `floor(old·bps/10000)` and `price_from_sqrt` binary inversion.)

**c) Boundary rounding.** The step uses `≤` on an integer product, so the exact
bound is `diff ≤ floor(x_old·k/10000)`. The dev bound is
`|p − P_oracle| ≤ floor(P_oracle·d/10000)`. Both were reproduced with Python
`isqrt` over `u128` semantics; a level exactly on the bound passes.

### 4.3 Why it can deadlock again

The pair tolerates gaps up to `(1+step)²/(1−dev) − 1 ≈ 1.256 %`. Any single
outage longer than the time the market takes to move beyond that (minutes in
volatile conditions) re-creates the deadlock. **The design is not self-healing.**
There is no instruction that resets `QuoteState.anchor_sqrt_price` to zero
(only `apply_quote_update` writes it, `lib.rs:1710`; `initialize_vault` zeroes it
only for a brand-new vault). So no permissionless recovery exists.

---

## 5. Keeper loop correctness issues

`scripts/devnet/keeper_loop.sh:28-34` — unbounded `while true`, restarts the driver
forever; an operator must kill it; a crash-loop can hammer the RPC.

`scripts/devnet/keeper_live.ts`:
- **False success** `:302` — `if (version > 0n) { success = true; }` accepts the
  *existing* stale version (18) as success. It never compares to a prior version.
- **Null tx misreport** `:291-297` — `const err = tx?.meta?.err ?? null;` treats a
  `getTransaction` that returned `null` (not yet indexed) as `err = null` (success).
  Observed in S2-16B: logged `err=null` while the tx actually failed `6015`.
- **No clamping** `:200-222` — proposes `anchor_sqrt(P_oracle)` and never clamps to
  the feasible interval, so it hits `AnchorStepTooLarge` after any gap.
- `skipPreflight: true` (`:281`) plus no backoff on failure = RPC spam.

Required semantics: success must mean **a confirmed transaction whose executed
result is success AND an independently reread `QuoteState.version` strictly
greater than the pre-attempt version with a fresh `expiry_slot`**. The S2-16C
work-in-progress (deterministic interval/freshness helpers + success classifier
tests) should land with the keeper fix.

---

## 6. Oracle freshness budget

On-chain semantics: `price_update.get_price_no_older_than(clock, max_staleness_seconds, feed)`
and `price.publish_time == update.oracle_publish_time` (`lib.rs:1463-1469`).
Devnet `max_staleness_seconds = 2`.

Measured (read-only probe `scripts/devnet/quote_latency_probe.ts`, this host,
public RPC, N = 20 — **small sample, not statistical confidence**):

| Stage | p50 | p90 | max |
|---|---|---|---|
| Hermes fetch round-trip | 384 ms | 694 ms | 735 ms |
| **Hermes publish-time age at fetch** | **424 ms** | **903 ms** | **1063 ms** |
| RPC `getLatestBlockhash` | 185 ms | 553 ms | 801 ms |
| RPC `getSlot` | 185 ms | 601 ms | 794 ms |
| RPC `getTransaction` | 147 ms | — | — |

From the S2-16B run, commits landed **~2–4 s** after `publish_time` (chain
`blockTime` vs Hermes `publish_time`); those in the 3–4 s band failed `6015`.
The Pyth post is inherently **two transactions** (Wormhole VAA + push oracle; see
`docs/PROGRESS.md` S2-10/S2-11) and the quote commit rides the second.

**Conclusion:** the 2 s budget is *achievable in principle* (S2-11/12/14 committed
successfully when latency was low) but is **not reliable** on a single public RPC:
Hermes alone already consumes up to ~1 s before any transaction, leaving ~1 s for
a ≥2-transaction, ≥2-confirmation path. This is an infrastructure/provider
limitation, not a reason to weaken the check blindly.

Host note: Node's default undici happy-eyeballs fails on this host's dead IPv6;
`NODE_OPTIONS=--no-network-family-autoselection` is required for Hermes (an
off-chain operational fix, not a protocol one).

---

## 7. Recovery options — ranked

Two blockers are **independent**: (i) anchor recovery; (ii) freshness + keeper
correctness. Fixing one does not fix the other.

### Option A — No configuration change: wait for price to re-enter range
- Requirement: `P_oracle ≤ 108.4343` (i.e. within +1.256 % of 107.0896). Current
  108.566 ⇒ needs ≈ −0.12 %.
- Resolves: anchor intersection (temporarily). Remains: freshness/keeper bugs.
- Not robust: any future >1.256 % gap re-locks. **Not recommended as a strategy.**

### Option B — Infrastructure + keeper fixes, **no on-chain change**
- **Clamp the keeper's anchor** to the feasible intersection (step ∩ dev) instead
  of the full oracle jump. At ≤1.256 % gaps this alone restores liveness with no
  admin action (this would have unblocked the S2-16B sample).
- Fix keeper success detection (§5), add bounded retry/backoff, multiple RPC
  providers, and pipeline Hermes prefetch.
- Resolves: the *reported* S2-16B deadlock, false-success reporting, and improves
  the freshness margin. **Does not resolve the current** (>1.256 %) deadlock —
  because the intersection is empty, clamping has nowhere to go.
- **Needed regardless of A/C.**

### Option C — Admin, timelocked parameter adjustment (proposal only)
- Smallest changes (exact): `max_anchor_step_bps 50 → 57` **or**
  `max_anchor_dev_bps 25 → 38`; applied via `set_params` (`lib.rs:986`) then
  `apply_params` (`lib.rs:1010`) after `TIMELOCK_SLOTS = 216 000`.
- Security trade-off: raising step widens the per-update anchor move (~1.14 % in
  price); raising dev widens how far the anchor may sit from the oracle (0.25 →
  0.38 %). Either modestly increases pick-off exposure; neither is "unsafe" in
  isolation, but neither is robust to the next outage.
- Resolves: current anchor deadlock. Remains: freshness + keeper bugs.
- **Proposal only — not applied.**

**Recommended:** **Option B now** (keeper clamp + correctness + provider
diversification) **combined with Option A-style design (Option D below) as a
contract change** so the protocol never again needs an operator or a parameter
tweak to heal. A one-off Option C bump is acceptable only as a stop-gap **if**
separately authorised and paired with B.

---

## 8. Target design — self-recovering anchor (contract change)

**Option D: Expired-quote re-anchoring (recommended).**

State machine (QuoteState):

```
FRESH   : version>0 ∧ now_slot < expiry_slot ∧ (now_ts − oracle_publish_time) ≤ max_staleness
EXPIRED : version>0 ∧ (now_slot ≥ expiry_slot ∨ oracle stale)
PRE_INIT: version==0
```

Rules:
- **FRESH → FRESH (normal refresh):** enforce *both* step and dev exactly as
  today. Anchor protection is unchanged for ordinary updates.
- **EXPIRED/PRE_INIT → FRESH (recovery):** keep **dev** (`max_anchor_dev_bps`,
  anchor bound to the *verified fresh* Pyth price), keep every other guard
  (confidence, spread band + step, weights/ladder shape, level band, inventory,
  capacity, monotonic slot, `max_update_slot_age`, freshness). **Skip only the
  step guard.** The anchor may jump directly to the verified oracle; timestamp and
  version advance; the next update is FRESH again and the step guard resumes.

Safety argument:
- The only weakened guard is the *successive* anchor-move limit. During recovery
  the new anchor is still bounded to within `max_anchor_dev_bps` of the **verified**
  price (Pyth signature + confidence cap), so a malicious keeper cannot choose a
  favourable anchor; the ladder/inventory/flow/capacity bounds still cap exposure.
- Recovery is gated on a genuinely expired/stale prior quote, which a keeper
  cannot forge (state-derived, not caller-supplied).
- Replay/griefing: monotonic `update_slot`, nonce, and `MAX_STAGE_AGE_SLOTS`
  (`lib.rs:25`) already apply; repeated recovery is impossible once FRESH.
- It cannot deadlock again: any gap is bridgeable in one permissionless update.
- The trade-off (larger single-step anchor move during a proven outage) is the
  **least dangerous** way to restore liveness without admin action.

Alternatives evaluated:
- **B — bounded transition** (relax dev for a limited window while stepping):
  works, but is strictly more complex and exposes a wider multi-update window for
  a smaller per-update jump. Inferior to D.
- **C — time-weighted `max_anchor_dev_bps`**: adds parameters and gaming surface.
  Not recommended.

Deterministic tests to add (local only): normal-market refresh passes; >1.256 %
jump FAILS step when FRESH and PASSES under recovery; invalid/stale/low-confidence
Pyth rejected in both paths; disjoint-interval detection; boundary `≤` rounding;
replay/expired-pending rejection.

---

## 9. Permissionless keeper design

- **Eligibility:** deploy with `min_bond > 0` (or remove the `min_bond==0`
  allowlist branch). Quote updates are then open to any bonded keeper
  (`require_keeper_authorized` already implements the bond PDA check).
- **Bond:** protects the protocol against a keeper quoting a bad ladder (slash to
  insurance). It **does not** create trustlessness by itself: slashing is
  admin-discretionary (`lib.rs:1202`). Either (a) define on-chain, objective
  slashing conditions (e.g. quoted-ladder capacity vs reserves, provenance
  failure) or (b) keep the bond small and treat it as anti-spam, not insurance.
- **Fees/oracle cost:** each keeper pays its own fees and Hermes access. Sustained
  operation needs a reward; route `keeper_bps` (currently 3333 of the fee split)
  to the keeper that actually committed each quote, not only `config.keeper`
  (`lib.rs:1252`). Only fund rewards from realised protocol revenue.
- **Concurrency / races:** `stage_quote`+`commit_quote` are already bound to
  `(vault, keeper)` via `[b"pending_quote", vault, keeper]` and a monotonic nonce,
  so competing keepers cannot clobber each other; last-write-per-slot is the only
  race and is harmless. Stale staging is bounded by `MAX_STAGE_AGE_SLOTS`.
- **Do** keep the pending-quote expiry and replay nonce.
- **DoS:** recovery gating + monotonic slot + `max_update_slot_age` prevent spam
  from advancing state; a small bond prices out trivial spam.

---

## 10. Administrative escape-hatch audit

| Control | Key | Timelock | Immutable bounds | Should become |
|---|---|---|---|---|
| `set_params`/`apply_params` (`lib.rs:986,1010`) | `8R3V…` | 216 000 slots | **none** (only fee-sum, spread order, util ≤8000 re-checked) | governance multisig + on-chain min/max caps for staleness, step, dev, update-age |
| `reset_breaker` (`lib.rs:960`) | admin | none | — | **permissionless after a cooldown**, or governance |
| `wind_down` (`lib.rs:975`) | admin | none | — | governance; withdrawals already unaffected |
| `slash_keeper` (`lib.rs:1202`) | admin | none | ≤ bond | objective on-chain criteria or governance |
| `claim_keeper_reward` (`lib.rs:1252`) | `config.keeper` | none | — | pay the committing keeper |
| Fee claims (`lib.rs:1307,1333`) | admin | 216 000 slots | fixed `treasury`; insurance not claimable | governance |
| Admin rotation (`lib.rs:1064-1118`) | admin → successor | 216 000 slots | — | governance |
| `initialize_program` (`lib.rs:34`) | first caller | none | — | gate to upgrade authority |
| **Upgrade authority** | `ddGs6hk5…` | none | — | **Squads v4 multisig**, then time-locked / frozen. Do **not** renounce outright before audit |

Positives: `trip_breaker` and `crank_epoch` are permissionless; `request_withdraw`
and `claim_withdraw` are **not** gated by `vault.status` (`lib.rs:302` and `lib.rs:351`), so an
admin cannot freeze user exits; slashed funds go to `insurance_quote`, never to
admin.

---

## 11. External dependencies — honest characterisation

- **Pyth + Wormhole + Solana**: the price is external but the **verification is
  on-chain**. ArbSwap's decentralisation guarantee is limited to "no single
  ArbSwap operator can change the price used" — it still trusts Pyth's publisher
  set and Wormhole. State this plainly.
- **RPC**: the frontend hardcodes `https://api.devnet.solana.com`
  (`app/src/chain/config.ts:35`); the keeper defaults to the same
  (`keeper_live.ts:161`). No key, but a single dependency. Add a provider
  fallback list; it is pure availability, not trust.
- **Hermes** (`hermes.pyth.network`, key-gated `.env`): used by the TS keeper to
  fetch updates. Replaceable by any Pyth access path; the on-chain receiver is
  the source of truth.
- **No hosted backend / database**: the indexer is a local CLI writing SQLite
  (`simulation/analytics/db.py`), dashboards are static files; nothing the protocol
  depends on. The `app` currently does not read `/analytics/onchain.json`.
- **Upgrade authority** (`ddGs6hk5…`): the single largest centralisation risk.

---

## 12. Migration plan

1. **Local model & tests (no chain):** land the anchor clamp + freshness + success
   classification helpers and their deterministic tests (S2-16C WIP); implement
   Option D validation locally and prove FRESH/EXPIRED behaviour with unit tests.
2. **Contract change + review:** add recovery branch to `validate_quote_update`;
   add immutable parameter caps; adjust `claim_keeper_reward`; external review.
3. **Devnet redeploy + multi-keeper test:** deploy to Devnet, run **≥2 independent
   wallets** as bonded keepers; verify competing stage/commit, and that any keeper
   can heal the vault after an induced outage.
4. **Failure injection:** keeper outage, RPC outage, stale quote, a >2 % price
   jump, and recovery — all measured, no manual parameter edits.
5. **Independent audit** of upgrade/admin controls; move upgrade authority to a
   multisig; gate `initialize_program`.
6. **Only then** a mainnet deployment plan (fees/rewards, provider SLAs, monitoring).

---

## 13. What this audit did and did not do

- Did: reread deployed state, reproduced integer arithmetic, measured latency
  (small sample), mapped every dependency and admin path with file:line evidence.
- Did not: send any transaction, change any policy, upgrade, or run a keeper.
- Added a read-only diagnostic `scripts/devnet/quote_latency_probe.ts` (no signing).
- Corrected the S2-16B finding: the reported 108.272 deadlock was a **units error**
  (a valid anchor existed; the keeper failed to clamp). The deadlock is **real at
  the current 108.57** because the gap (+1.378 %) exceeds the bridgeable +1.256 %.

---

## S2-20 update — status of the recommended remediation (local only)

Implemented locally (not deployed; see `docs/S2_20_IMPLEMENTATION.md`):

- **Permissionless keepers (§9):** allowlist removed; `min_bond==0` ⇒ any valid
  signer, `min_bond>0` ⇒ any bonded keeper. Eligibility made immutable by
  removing `min_bond`/`keeper` from `ParamsUpdate`.
- **Quote attribution (§4/§5 of this audit, Option D applied to rewards):** the
  authoring keeper is recorded in `QuoteState.keeper`; the keeper fee share is
  credited to that keeper's `KeeperReward` PDA at swap time and claimable only by
  that keeper. Fee split and reserve accounting unchanged.
- **Expired-quote recovery (§5):** the S2-18 recovery branch (`quote_reanchor_eligible`)
  is retained and tested.

Still open (require authorisation / a deploy):

- `QuoteState` account migration (865 → 897 bytes, append `keeper`).
- Retiring the single upgrade authority (`ddGs6hk5…`) to a multisig; no change made.
- Objective slashing criteria (none invented).
- Oracle freshness remains provider-sensitive; the 2 s rule was not changed.

---

## S2-22 governance review (no change made)

Routine quote maintenance and recovery are permissionless (`min_bond==0`); keeper
eligibility is immutable (S2-20). Remaining centralized controls, all requiring an
administrator and all outside routine quote operation: single-key **upgrade
authority** `ddGs6hk5…`; timelocked `set_params`/`apply_params` (params other than
eligibility); `reset_breaker`; `wind_down`; discretionary `slash_keeper` (no
objective criteria); timelocked fee claims; timelocked admin rotation;
claim-once `initialize_program`. Reducing these requires a multisig upgrade
authority plus on-chain slashing criteria — not implemented here and not claimed
as decentralized.
