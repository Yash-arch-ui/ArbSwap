# STATUS.md — what each status word means (F1)

This repo uses one status per item. The words are defined so a reader can tell a
**finished** item from a **honestly abandoned** one without reading the code.

| Status | Meaning | Required evidence |
|---|---|---|
| **PASS / DONE** | The item is implemented and verified. | A test, measurement, or committed artifact. |
| **CLOSED-BY-DECISION** | The item is **deliberately** not done, and there is a **written technical reason with evidence** (a measurement, a proof, a cost/benefit number, or an external constraint). Effort, budget, or "it is large" is **not** a technical reason. | The reason plus a link to the evidence. |
| **NOT DONE** | The item is not done and **no** qualifying technical reason exists. This is the honest default. | The gap is stated as a gap. |
| **EXTERNAL** | Blocked on something outside this repository that cannot be obtained here (e.g. a third-party service, a funded key, an independent auditor). | The exact external dependency is named. |
| **SKIPPED** | Conditional item whose precondition was absent at run time. | The precondition and how to enable it. |

## Consequences for the B-series

Applying the table above:

- **B2 (verify-instead-of-compute redesign)** — **NOT DONE.** The only reason
  given ("large on-chain redesign") is effort, not a technical impossibility, and
  the conservative-rounding equivalence is not proved here. It must not be
  labelled CLOSED-BY-DECISION.
- **B5 high-volatility real windows** — **NOT DONE.** Binance public archives are
  downloadable with `simulation/data/download_vision.py` (two are downloaded and
  used by the F5 amendment). "EXTERNAL (data)" was incorrect: the data is not
  external, it was simply not fetched.
- **B5 T-A.i real-flow bootstrap CIs** — see `docs/THESIS.md` Amendment 4: run or
  **NOT DONE** (it is runnable from the archived aggTrades).
- **B6 E8 one-hour proxy** — **NOT DONE.** The public quote API is reachable and
  rate-limitable; the 60-sample run was a choice, not a constraint. It is not
  CLOSED-BY-DECISION.
- **B8 keeper robustness** — **PASS (offline).** Implemented: offline
  pre-validation (`arbswap_keeper::prevalidate_quote`) mirroring the on-chain
  knowable bounds, plus failure-injection tests (dropped tx, blockhash expiry,
  duplicate send, out-of-order slot, stale/wide oracle, clock skew, safe
  failure). Live-devnet injection remains **SKIPPED** (no keypair).
- **Independent audit** — **EXTERNAL.**
