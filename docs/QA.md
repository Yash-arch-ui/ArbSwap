# QA.md — hard questions and honest answers

Prepared for judges/reviewers. Numbers are not repeated here; see
`docs/CLAIMS.md` and `artifacts/public/` (single source of truth). "No known
issues in self-review, independent audit pending."

## Q1. What is ArbSwap, in one sentence?
An on-chain, keeper-quoted RFQ-style AMM for a WSOL/USDC (devnet test-token)
pair: a permissionless bonded keeper commits a signed ladder quote; traders swap
against it; LPs deposit/withdraw with warm-up and epoch settlement.

## Q2. Is the value thesis (Option 1) shown?
**No — and we say so.** Option 1 is **not shown**. The routed/volume study did not
meet the pre-registered bar on the available data (see `docs/P1_RESULTS.md`,
`docs/THESIS.md`, `docs/RESULTS.md`). We report the negative result rather than
reframe it.

## Q3. Why does ArbSwap get a near-zero routed-volume share against a tight
propAMM-like venue?
Because a tight, well-capitalized propAMM-like venue already quotes inside us on
the modeled flow; we do not win share on price in that regime. Our claimed edge
is in the **volatility/jump** regime and in **LP-facing** properties, not raw
taker share. The losing regimes are shown, not hidden (`docs/CLAIMS.md`).

## Q4. What is the stale-quote exposure?
Quotes are valid for **120 slots** (about 30 s at ~0.248 s/slot on this devnet).
The **oracle must be within 2 s at commit time**, but a `swap` does **not**
re-check oracle age — so a longer quote validity increases stale-price exposure.
This is bounded by the anchor-deviation bound (`max_anchor_dev_bps`), the
per-window flow cap, and the realized-edge breaker. It is a **known, bounded
residual risk**, not eliminated.

## Q5. What is the single-sided deposit/withdrawal design, and its risk?
Single-token entry/exit is designed natively on the vault's **own ladder**
(`docs/SINGLE_SIDED_DESIGN.md`): `deposit_single` swaps part of the input
internally, then deposits both legs; `claim_withdraw_single` converts the
unwanted leg and pays one token. It **inherits the same stale-quote exposure as a
swap**. On-chain program work is **NO-GO for this window** (D-011); the design is
the roadmap. A browser-only `swap`+`deposit` composition is the fast fallback.

## Q6. Who controls the upgrade authority?
A **single key** (`ddGs6hk5…`) today. This is a real centralization point. A
multisig (e.g. Squads) is the intended successor; the program already supports a
timelocked admin rotation (`propose_admin`/`accept_admin`/`cancel_admin`). Not
yet rotated on devnet.

## Q7. What did you not verify / what is external?
- Independent security audit: **pending** (none).
- Real-pool value data (E8) and the one-hour proxy: **not done**.
- Browser **wallet-signed** swap: only the operator can do it (we recorded
  CLI-signed devnet evidence instead).
- Some dependency advisories are **waived, dated** (`docs/WEB_ASSUMPTIONS.md`,
  `frontend/audit-allowlist.json`); the gate verifies waived packages are absent
  from the built bundle.

## Q8. Are the tokens real?
No. All tokens are **devnet test tokens** with no value.

## Q9. Why is the CSP not strict (no `unsafe-inline`)?
Browser wallet extensions inject an inline provider script; removing
`script-src 'unsafe-inline'` breaks wallet detection on a deployed origin
(D-013). There is **no `unsafe-eval`**.

## Q10. How is correctness guarded?
Guard-mutation table (`docs/SECURITY_CHECKLIST.md`), full LiteSVM lifecycle +
adversarial suites, Python reference parity + golden vectors, differential and
fuzz targets, docs/bundle single-source-of-truth checks, and a secrets scan over
tracked files and the built bundle.
