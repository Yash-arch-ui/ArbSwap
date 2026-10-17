# PITCH_OUTLINE.md — 10-slide outline

Use only numbers from the artifact bundle (`artifacts/public/`) and real devnet
signatures (`docs/DEVNET.md`). Do not describe test tokens as real assets. Do not
claim Option 1.

1. **Problem.** On-chain AMMs on Solana lose to informed flow in volatile
   regimes; passive LPs carry the adverse-selection cost.
2. **Idea.** A keeper-quoted, RFQ-style ladder with an explicit fee split and
   LP adverse-selection protections (warm-up, epoch settlement, flow cap, edge
   breaker).
3. **Architecture.** Program + keeper + oracle + dApp (one diagram); committed
   quotes, permissionless bonded quoting.
4. **What is on-chain.** `swap`, `deposit`/withdraw lifecycle, quote commit,
   breaker, timelocked params — with the LiteSVM evidence.
5. **Volatility/jump detector.** EWMA + jump guard, timelocked activation; the
   guard only affects `apply`, not swap/deposit.
6. **Honest result.** The routed/volume study did **not** meet the bar (Option 1
   not shown); show the losing regimes and the near-zero routed share vs a tight
   propAMM-like venue.
7. **What we claim.** Mechanism-level claims with evidence (`docs/CLAIMS.md`);
   "no known issues in self-review, independent audit pending."
8. **Live devnet proof.** Real test-token deposit, staged/committed quotes, swap,
   upgrade, expiry apply — with explorer links.
9. **Single-sided entry/exit.** Natively on the vault's own ladder
   (`deposit_single`/`claim_withdraw_single`): implemented, mirrored by a Python
   reference (600 vectors + 100k differential + 20k fuzz), LiteSVM-tested,
   deployed on devnet; **live devnet smoke passed for both base and quote
   directions** (CLI-signed); browser UI behind a fail-closed flag (off by
   default, pending a wallet-signed smoke). Bounded residual risk (inherits the
   swap's stale-quote exposure).
10. **Status & next.** Gate-green repo, fresh bundle, ready-to-deploy dApp
    (`docs/DEPLOY_FRONTEND.md`); next = audit, E8 real-pool data, browser
    wallet-signed single-token smoke.
