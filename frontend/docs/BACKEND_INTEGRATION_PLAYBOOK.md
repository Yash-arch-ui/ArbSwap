# BACKEND_INTEGRATION_PLAYBOOK.md

**How to connect the ArbSwap backend (Anchor program + keeper + artifact
bundle) to the dApp on the `frontend` branch, end to end — a hackathon-level,
demonstrable build.**

Scope: `frontend/` dApp (Vite + React 19 + TS). Backend: `vault/program`
(Anchor), `vault/keeper`, `artifacts/public/*`. Devnet only. Every token shown
is **TEST TOKEN, devnet** and worthless. The backend remains the source of
truth: the UI reads the chain and the artifact bundle and never re-derives
protocol math to invent numbers.

---

## 0. Honesty contract (do not violate)

- The UI never computes a protocol quote/client result and presents it as truth.
  It reads on-chain `QuoteState` and lets the program enforce `min_out`.
- A **memo is not a swap.** No "proof of trade" fallback is allowed.
- Every displayed number is one of: on-chain state, wallet balance, or a value
  from `artifacts/public/*` labelled with its `manifest.commit` and type
  (model output / replay / route-quote proxy / on-chain).
- Missing data shows an explicit **unavailable** state, never a substituted
  mock constant.
- Banned wording: follow the prohibited-claims list in `docs/CLAIMS.md`
  exactly; run `scripts/banned_words.py` before shipping any UI copy. No return
  projections or promotional superlatives.

---

## 1. Architecture: what "the backend" actually is

| Layer | Where | Role | UI reads/writes |
|---|---|---|---|
| Anchor program | `vault/program`, deployed at `2mwp…` | Vault state, quotes, swaps, deposits/withdrawals, keeper bonds/slashing, breaker | tx instructions; account reads (Vault/Config/QuoteState) |
| Keeper | `vault/keeper` | Reads Pyth, builds the 6-level two-sided ladder, posts `update_quote` | none (operator process) |
| Evaluation artifacts | `artifacts/public/*.json` (+ schema) | Static model/replay results | read-only HTTP `./artifacts/*.json` |
| Pyth oracle | feed `0xef0d…b56d`, receiver `rec5EKMGg6…` (devnet) | Reference price | consumed on-chain by `update_quote` |

Two distinct data sources — **live chain** and **static artifacts** — must never
be blended into one ambiguous model.

---

## 2. Current state audit of `frontend/` (fix these first)

The branch is a strong **UI** with a broken **chain** layer:

1. **Stale hardcoded addresses** (`frontend/src/chain/solana.ts:11-19`):
   `ARBSWAP_VAULT_PUBKEY = 8pubuch…` is owned by the **closed** program
   `CCR33kX4…`; base/quote mints are the old `Aiv3cxv…`/`EwGBJg2…`. The live
   program is `2mwp…` and has **no vault initialized**.
2. **Memo fallback presented as a trade** (`frontend/src/pages/SwapPage.tsx:178-197`):
   when the wallet lacks the base ATA, it sends a `MemoSq4gq…` transaction and
   shows a `confirmed` receipt labelled "On-Chain Devnet Trade Proof". **Remove.**
3. **Mock substitution in decoders** (`solana.ts:100-108`): missing fields fall
   back to `2.41`, `1.8`, etc. **Remove.**
4. **No Anchor client**: `package.json` lacks `@coral-xyz/anchor` and
   `@solana/spl-token`; instructions are hand-built from guessed offsets.
5. **Fabricated artifact fallbacks** (`protocolArtifacts.ts:75-77`):
   `0.016`, `1.99`, `627.6`. **Remove.**

Everything below replaces those five items.

---

## 3. Prerequisites

```bash
# tools
solana --version      # 4.1.2 (match NOTES.md)
anchor --version      # 1.1.2
cargo --version       # 1.98.0
node --version        # 24
python3 --version     # 3.12

# environment (devnet only; key path OUTSIDE the repo, never committed)
export ARBSWAP_DEVNET_KEYPAIR="$HOME/.config/solana/arbswap-devnet.json"
solana config set --url https://api.devnet.solana.com
# Pyth Hermes needs an API key (kept in .ENV, never committed)
export PYTH_API_KEY=...        # from .ENV
```

Devnet RPC: `https://api.devnet.solana.com`.

---

## 4. Authoritative constants (do not invent)

| Item | Value |
|---|---|
| Program id (`declare_id!` = `Anchor.toml`) | `2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm` |
| `program_config` `[b"program"]` | `J6MGfX1YvGq6yCP3eAqzbugpF83CTaBcTLKcmrxmBSok` (admin `8R3V…`) |
| Base mint (tSOL, 9 dp) — TEST TOKEN | `76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2` |
| Quote mint (tUSDC, 6 dp) — TEST TOKEN | `q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX` |
| Pyth SOL/USD feed id | `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| Pyth receiver program (devnet) | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |

PDAs are functions of the pair (never hardcode them):

```text
vault        = [b"vault", base_mint, quote_mint]
config       = [b"config", vault]
quote_state  = [b"quote",  vault]
bond_vault   = [b"bond",   vault]
deposit_tkt  = [b"dep", vault, user]
withdraw_tkt = [b"wd",  vault, user]
keeper_bond  = [b"keeper", vault, keeper]
program_cfg  = [b"program"]
```

`share_mint`, `share_lock`, `base_reserve`, `quote_reserve` are **new keypairs
created by `initialize_vault`** — read their addresses from the `Vault` account,
never guess them.

> Status: the vault is **not initialized** yet (S2.3 pending operator approval),
> so a live read returns `exists:false`. The UI must show "Vault not
> initialized" until Step B4 completes.

---

## 5. Backend pipeline (operator) — get the chain ready

### B1. Program build + hash check
```bash
rm -rf target/cu
( cd vault/program && CARGO_TARGET_DIR="$PWD/../../target/cu" cargo build-sbf )
cp target/cu/deploy/arbswap.so target/deploy/arbswap.so
sha256sum target/deploy/arbswap.so      # expect 9a05056e… (688,616 B)
.venv/bin/python scripts/devnet_program_hash.py \
  --program-id 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  --rpc https://api.devnet.solana.com --so target/deploy/arbswap.so   # MATCH
```

### B2. Test mints (already created)
tSOL `76Xvqd…` (9 dp) / tUSDC `q3xHxvx…` (6 dp), mint authority `8R3V…`, no
freeze. Per-call caps in `scripts/test_tokens.sh` (5 tSOL / 5,000 tUSDC —
enforced).

### B3. Program admin (already claimed)
`initialize_program` created `program_config`; admin = `8R3V…`. Do **not**
re-run.

### B4. Initialize the vault
Accounts (order): `admin, program_config, vault, config, quote_state, base_mint,
quote_mint, base_reserve, quote_reserve, share_mint, share_lock, token_program,
system_program, rent`. **Signers: admin + 4 new keypairs** (`base_reserve`,
`quote_reserve`, `share_mint`, `share_lock`). Args = `InitParams` (fees, oracle
feed, warm-up/epoch/expiry, spreads, caps, utilization, edge/flow windows,
ladder offsets/weights). Record the returned reserve/share addresses — the UI
reads them from the `Vault` account, so they must be authoritative.

### B5. Seed liquidity
`deposit(base_amount, quote_amount, min_shares)` once per LP; the first deposit
mints `isqrt(dB·dQ) − min_liquidity` to the LP and locks `min_liquidity`.

### B6. Run the keeper (posts quotes)
```bash
# decimals are read from the mints (S2.3 fix); one live process per vault
cargo run -q -p arbswap-keeper -- live \
  https://api.devnet.solana.com 2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm \
  <vault> <config> <quote_state> <base_reserve> <quote_reserve> \
  <pyth_price_update_account> <keeper_bond> "$ARBSWAP_DEVNET_KEYPAIR" \
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d \
  60 50 1000 0 0 10000
```
Hermes posting helper: `PYTH_API_KEY=... npx tsx scripts/devnet/post_pyth.ts`.

### B7. Publish artifacts (already present)
```bash
.venv/bin/python scripts/export_artifacts.py
.venv/bin/python scripts/publish_artifacts.py
.venv/bin/python scripts/render_docs.py
```

Once B4–B6 are done, `fetchProtocolState()` returns `exists:true` with live
levels, and swaps can move tokens.

---

## 6. Frontend wiring — the actual "connect the backend" work

### F1. Dependencies
```bash
cd frontend
npm i @coral-xyz/anchor @solana/spl-token
```

### F2. Ship the IDL into the app
```bash
anchor idl build -p arbswap -o target/idl/arbswap.json
mkdir -p frontend/src/idl
cp target/idl/arbswap.json frontend/src/idl/arbswap.json
```
(Anchor's client needs the IDL; do not hand-encode instruction data.)

### F3. Replace hardcoded constants (`frontend/src/chain/solana.ts`)
Delete the stale vault/reserve/share/mint literals. Keep only the program id and
the **pair**; derive everything else:

```ts
export const ARBSWAP_PROGRAM_ID = new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm');
export const BASE_MINT  = new PublicKey('76XvqdSVi2LhYWgeWjx6E1V2c7oBeB6ndUEp6xC44jp2'); // tSOL
export const QUOTE_MINT = new PublicKey('q3xHxvxCBvYCMwuA6dFtTDHHwbqkrruTYWAWXdPuNFX'); // tUSDC
export const PYTH_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
```

### F4. Chain client with Anchor (`frontend/src/chain/program.ts`, new)
Replace the manual `buildSwapInstruction` and byte decoders with Anchor:

```ts
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from '../idl/arbswap.json';
import { ARBSWAP_PROGRAM_ID, BASE_MINT, QUOTE_MINT } from './solana';

export function getProgram(connection, wallet): Program {
  return new Program(idl as never, new AnchorProvider(connection, wallet, { commitment: 'confirmed' }));
}

export function deriveVaultAddresses(base = BASE_MINT, quote = QUOTE_MINT) {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), base.toBuffer(), quote.toBuffer()], ARBSWAP_PROGRAM_ID);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config'), vault.toBuffer()], ARBSWAP_PROGRAM_ID);
  const [quoteState] = PublicKey.findProgramAddressSync([Buffer.from('quote'), vault.toBuffer()], ARBSWAP_PROGRAM_ID);
  return { vault, config, quoteState };
}

// fetch decoded accounts (Anchor returns camelCase fields for this IDL)
export async function fetchProtocolState(connection) { /* see §7 */ }

export async function swap(connection, wallet, side, amountIn, minOut, minVersion) {
  const program = getProgram(connection, wallet);
  const { vault, config, quoteState } = deriveVaultAddresses();
  const owner = (wallet as any).publicKey;
  const state = await fetchProtocolState(connection);
  if (!state.vaultData) throw new Error('vault not initialized');
  return program.methods.swap(side, new BN(amountIn), new BN(minOut), new BN(minVersion))
    .accounts({ trader: owner, vault, config, quoteState,
      baseReserve: state.vaultData.baseReserve, quoteReserve: state.vaultData.quoteReserve,
      traderBase: getAssociatedTokenAddressSync(BASE_MINT, owner),
      traderQuote: getAssociatedTokenAddressSync(QUOTE_MINT, owner),
      tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
}
```

**Field names:** `program.account.*.fetch` returns **camelCase** for this IDL
(`totalShares`, `baseReserve`, `askLevels`, `halfSpreadBps`). The raw
`BorshCoder.accounts.decode` returns **snake_case**. Do not mix them.

### F5. Live-state mapping (`frontend/src/chain/live.ts`, new)
Convert on-chain values to UI units without inventing numbers:

```ts
const Q128 = new BN(1).ushln(128);
// Q64.64 sqrt price -> human USD price; base(9)/quote(6) => ×10^(9-6)
export function humanPriceFromSqrt(sqrt: BN): number {
  const scaled = sqrt.mul(sqrt).muln(1_000_000_000 * 1000).div(Q128);
  return Number(scaled.toString()) / 1_000_000_000;
}
// base capacity of a level: L·(hi-lo)/(lo·hi); quote: L·(hi-lo)/2^128
```

### F6. Context: replace the mock ticker
`frontend/src/context/ProtocolContext.tsx` currently seeds from
`INITIAL_QUOTE_STATE`/`INITIAL_VAULT_STATE` and simulates. Replace with a poll:

```ts
useEffect(() => {
  const tick = async () => {
    const [state, slot] = await Promise.all([fetchProtocolState(connection), connection.getSlot()]);
    setVaultInitialized(state.exists);
    setQuoteState(toQuoteState(state, slot));
    setVaultState(toVaultState(state, oraclePrice, userShares));
    setRiskBreakers(toRiskBreakers(state, nowUnix));
  };
  void tick();
  const id = setInterval(tick, 8000);
  return () => clearInterval(id);
}, [connection, publicKey]);
```

Expose `vaultInitialized` so pages can gate actions.

### F7. Artifact layer (`frontend/src/data/protocolArtifacts.ts`)
Keep the typed imports from `../artifacts/*.json`, but:
- delete fabricated fallbacks (`627.6`, `0.016`, `1.99`);
- label every metric with `manifest.commit` + type;
- keep the losing regime and the E8 proxy caveat visible (see §8).

### F8. Remove the memo fallback (`SwapPage.tsx`)
Delete the `MemoSq4gq…` branch. On the real path:
- pass the **actual quoted version** as `minVersion` (not 0), so stale quotes
  revert;
- derive `min_out` from the on-chain ladder or a user slippage tolerance;
- map errors: `QuoteExpired`, `VersionTooOld`, `CapacityExceeded`,
  `SlippageExceeded`, `Paused`;
- show the real signature + explorer link, then `refreshBalances()`.

### F9. Page-by-page wiring

| Page | Reads (live/artifacts) | Writes | Kill mocks |
|---|---|---|---|
| **Overview** | `Vault` (reserves, status), `QuoteState` (price, spread, expiry), artifact headline | — | `INITIAL_*` |
| **Swap** | `QuoteState` ask/bid levels; wallet balances | `swap(side, amount_in, min_out, min_version)` | mock quote + memo |
| **Vault** | `Vault` (reserves, `total_shares`, `epoch`), user share ATA, `DepositTicket`, `WithdrawTicket` | `deposit`, `request_withdraw`, `crank_epoch`, `claim_withdraw` | `INITIAL_VAULT_STATE`, `MOCK_USER_TICKETS`, `netHedgedApy` |
| **Risk** | `Config` bounds + `QuoteState` staleness/conf/expiry + `Vault.status` | admin-only `reset_breaker`, `wind_down` | mock `RISK_BREAKERS` |
| **Analytics** | all `artifacts/public/*` | — | `MOCK_LVR_DATA`, `MOCK_QUOTE_VS_FILL` |

### F10. Provenance component
One compact badge showing `manifest.commit`, `flow_type`, `schema_version`, and
per-metric type labels (model output / replay / route-quote proxy / on-chain).

---

## 7. Reference: `fetchProtocolState` (authoritative decode)

```ts
export async function fetchProtocolState(connection) {
  const { vault, config, quoteState } = deriveVaultAddresses();
  const ro = { publicKey: PublicKey.default, signTransaction: async t => t, signAllTransactions: async t => t };
  const program = new Program(idl as never, new AnchorProvider(connection, ro as any, { commitment: 'confirmed' }));
  if (!(await connection.getAccountInfo(vault))) return { exists: false, vault, config, quoteState };
  const v: any = await (program.account as any).vault.fetch(vault);
  const readAmount = async (a) => { try { return new BN((await connection.getTokenAccountBalance(a)).value.amount); } catch { return new BN(0); } };
  const [baseReserveAmount, quoteReserveAmount] = await Promise.all([readAmount(v.baseReserve), readAmount(v.quoteReserve)]);
  const q: any = await (program.account as any).quoteState.fetch(quoteState).catch(() => null);
  return {
    exists: true, vault, config, quoteState,
    vaultData: { ...v, baseReserveAmount, quoteReserveAmount },
    quoteData: q ? {
      version: q.version, updateSlot: q.updateSlot, expirySlot: q.expirySlot,
      halfSpreadBps: q.halfSpreadBps, askExtraBps: q.askExtraBps, bidExtraBps: q.bidExtraBps,
      depthMultBps: q.depthMultBps, oraclePublishTime: q.oraclePublishTime, oracleConfBps: q.oracleConfBps,
      askLevels: q.askLevels, bidLevels: q.bidLevels,
    } : undefined,
  };
}
```

## 8. Units and data contract

- Base tSOL 9 dp, quote tUSDC 6 dp; `base_atom_scale = 10^(9−6) = 1000`.
- Human price from Q64.64 sqrt `p`: `price = (p/2^64)^2 × 1000`.
- Fee buckets (`insurance/keeper/protocol`) are liabilities, excluded from
  tradeable reserves.
- Artifacts: `headline.json`, `held_out.json`, `routed_world.json`,
  `envelope.json`, `thesis.json`, `cu.json`, `mutation.json`,
  `test_counts.json`, `e8_proxy.json`, `manifest.json` — validate against
  `artifacts/schema/*.json`.
- Honesty labels: E8 = **route-quote proxy**, not an executed fill; keep the
  quiet-flow half-spread loss and the real-flow calibration caveat visible.

## 9. Tests and gates

```bash
cd frontend
npm run lint          # oxlint
npm run build         # tsc -b && vite build
npm test              # vitest (add: artifact load/missing/malformed/schema-invalid,
                      # provenance, model-vs-proxy labels, decode fixtures)
# backend/security
.venv/bin/python scripts/check_docs_consistency.py
.venv/bin/python scripts/banned_words.py
.venv/bin/python scripts/secrets_scan.py
.venv/bin/python scripts/check_bundle_freshness.py
node scripts/frontend_audit_gate.mjs
```
Never weaken TS settings or skip a failing gate.

## 10. Deployment + demo (hackathon)

- Deploy `frontend/` (Vercel root `frontend/`, build `npm run build`, output
  `dist`) against devnet.
- `docs/TESTER_GUIDE.md`: switch Phantom/Solflare to devnet → get devnet SOL →
  receive **TEST TOKEN**s → connect → swap → deposit → request/claim withdrawal.
- 90-second demo: connect → show live `QuoteState` → swap (real sig + balance
  delta) → deposit → show shares/warm-up → analytics with provenance and the
  losing regime.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Balances never change | memo fallback / vault not initialized | remove memo (§F8); complete B4–B6 |
| `AccountOwnedByWrongProgram` | stale vault from closed `CCR33…` | derive PDAs from the pair (§F3/F4) |
| `Vault not initialized` | no vault account | run B4 |
| `QuoteExpired` | keeper not running | run B6 |
| `VersionTooOld` | `min_version` too high | pass the current `QuoteState.version` |
| fields `undefined` | snake_case vs camelCase mix | use camelCase from `account.fetch` |
| swap rejected on ATA | wallet lacks pair tokens | fund via `scripts/test_tokens.sh` |

## 12. Definition of done

- The app builds and shows **live** vault/quote state or an explicit
  "not initialized" state — never mock numbers.
- A swap produces a real signature and a real token-balance delta, or a clear
  on-chain error. No memo path exists.
- Analytics read the committed artifact bundle with provenance and honest
  labels.
- All gates pass; nothing pushed to `main`; TEST TOKEN labelling everywhere.
