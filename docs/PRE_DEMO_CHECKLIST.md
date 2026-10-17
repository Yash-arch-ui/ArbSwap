# PRE_DEMO_CHECKLIST.md — run this ~1 hour before the demo

Devnet only. Test tokens only. Keep the keeper (tmux `arbswap-keeper`) running.

## T-60 min
- [ ] Keeper tmux session alive: `tmux ls` shows `arbswap-keeper`.
- [ ] Keeper committing fresh quotes: QuoteState `version` advancing and
      `fresh: true` most of the time (occasional provider 429 gaps are normal).
- [ ] On-chain: `solana program show 2mwpYHpZ… --url devnet` → authority
      `ddGs6hk5…`, deployed length matches the recorded artifact.
- [ ] Vault Active; `Config.expiry_slots == 120`.
- [ ] Admin wallet `8R3V…` funded (SOL) and holds WSOL + USDC; SOL wrapped.
- [ ] `docs/DEMO_SCRIPT.md` open on a second screen.

## T-15 min
- [ ] Open the deployed dApp; connect wallet; confirm **devnet** banner.
- [ ] Swap page: quote is fresh, price shown matches a public Hermes check.
- [ ] Vault page: deposit/withdraw panels render; balances correct; no mock data.
- [ ] Risk/Overview: live QuoteState/volatility values; limits text present.
- [ ] Run the one-command check: `scripts/devnet/demo_check.sh` (read-only).
- [ ] Single-sided toggles are **hidden** (default build has
      `VITE_ENABLE_SINGLE_SIDED` unset). Do not enable them for the default demo;
      see `docs/BROWSER_WALLET_SMOKE.md` for the separate, wallet-gated test.

## T-0
- [ ] Backup video ready on the laptop **and** phone (`docs/demo_backup.mp4`) in
      case the keeper stalls or the network is flaky.
- [ ] Fallback order, if live fails: (1) live dApp → (2) demo mode (offline,
      deterministic replay, no wallet) → (3) recorded devnet evidence page →
      (4) backup video.
- [ ] Phone hotspot ready as a network backup.

## Do not
- [ ] Do not change any vault or volatility parameter.
- [ ] Do not paste any key or keyed URL into the UI or chat.
- [ ] Do not describe test tokens as real assets.
