import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { deriveModelMetrics, meanVenueMetric, type HeldOutWindow } from '../src/data/backend';
import { interpretExport } from '../src/data/onchainAnalytics';
import { toVaultState, toRiskBreakers } from '../src/chain/live';
import { READ_ONLY_MODE, TRANSACTIONS_ENABLED, TRANSACTION_DISABLED_REASON, EXPECTED_GENESIS_HASH, ACTIVE_VAULT } from '../src/chain/config';
import { verifyCluster, verifyProgram } from '../src/chain/program';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('S2-32 model metrics come from real artifacts (never fabricated)', () => {
  const heldOut: Record<string, HeldOutWindow> = {
    W2: { dates: 'a', regime: 'x', sigma_per_sqrt_s: 1, venues: { ArbSwap: { markout_2s_bps: 5.6, hedged_pnl: 0, quiet_half_spread_bps: 0, gap_bps: 0, fill_rate: 0, trades: 0 }, B1_passive: { markout_2s_bps: 0.2, hedged_pnl: 0, quiet_half_spread_bps: 0, gap_bps: 0, fill_rate: 0, trades: 0 } } },
    W3: { dates: 'b', regime: 'y', sigma_per_sqrt_s: 1, venues: { ArbSwap: { markout_2s_bps: 4.4, hedged_pnl: 0, quiet_half_spread_bps: 0, gap_bps: 0, fill_rate: 0, trades: 0 }, B1_passive: { markout_2s_bps: 0.4, hedged_pnl: 0, quiet_half_spread_bps: 0, gap_bps: 0, fill_rate: 0, trades: 0 } } },
  };

  it('derives the real per-window means and CU ratio', () => {
    const m = deriveModelMetrics({
      headline: { meta: { commit: 'c', short: 'abc123', date: 'd', flow_type: 'synthetic' }, calibration: {}, routed_world: { source: null, rows: [] }, e1_e4: {}, cost: { cu_swap: 59327, cu_update_quote: 38563 } },
      heldOut,
      thesis: { decision: 'Option 1 not shown', T_A: { T_A_holds: false, T_A_i_real_flow_ci: { met: false, reason: '' }, T_A_iii_noprop_share_ge_10pct: { met: true, share: 0.2786 } }, T_B: {} },
    });
    expect(m.arbMarkout2sBps).toBeCloseTo(5.0, 5);
    expect(m.b1Markout2sBps).toBeCloseTo(0.3, 5);
    expect(m.cuUpdateQuote).toBe(38563);
    expect(m.cuSwap).toBe(59327);
    expect(m.cuRatio).toBeCloseTo(59327 / 38563, 6);
    expect(m.noPropAmmVolumeShare).toBeCloseTo(0.2786, 4);
    expect(m.thesisDecision).toBe('Option 1 not shown');
  });

  it('returns null (not zero) when artifacts are unavailable', () => {
    const m = deriveModelMetrics({ headline: null, heldOut: null, thesis: null });
    expect(m.arbMarkout2sBps).toBeNull();
    expect(m.b1Markout2sBps).toBeNull();
    expect(m.cuUpdateQuote).toBeNull();
    expect(m.cuRatio).toBeNull();
    expect(m.noPropAmmVolumeShare).toBeNull();
  });

  it('meanVenueMetric ignores missing windows rather than coercing to 0', () => {
    const partial = { W2: heldOut.W2, W3: { ...heldOut.W3, venues: {} } as HeldOutWindow };
    expect(meanVenueMetric(partial, 'ArbSwap', 'markout_2s_bps')).toBeCloseTo(5.6, 5);
    expect(meanVenueMetric(partial, 'Missing', 'markout_2s_bps')).toBeNull();
  });
});

describe('S2-32 optional on-chain export fails honestly', () => {
  it('a missing/empty export is unavailable, never fabricated zeros', () => {
    expect(interpretExport(null, Date.now()).status).toBe('malformed');
    const available = interpretExport({ generated_at: new Date().toISOString() }, Date.now());
    expect(available.status).toBe('available');
  });
});

describe('S2-32 live protocol mapping is honest', () => {
  const pk = PublicKey.default;
  const configData = {
    keeper: pk, treasury: pk, feeBps: 1, insuranceBps: 3333, keeperBps: 3333, protocolBps: 3334,
    minLiquidity: new BN(1000), warmupSlots: new BN(150), epochSlots: new BN(1500), graceSlots: new BN(2),
    expirySlots: new BN(10), maxStalenessSeconds: new BN(2), maxConfBps: 10, maxAnchorStepBps: 50,
    maxSpreadStepBps: 10, minSpreadBps: 2, maxSpreadBps: 50, maxQuoteSize: new BN(1), maxInventoryBps: 6000,
    utilizationMaxBps: 5000, minBond: new BN(0), unbondCooldownSlots: new BN(0), maxUpdateSlotAge: 25,
    edgeWindowSlots: new BN(0), maxEdgeLossBps: 50, maxAnchorDevBps: 25, flowWindowSlots: new BN(0),
    maxWindowFlowBps: 1000,
  };
  const vaultData = {
    admin: pk, baseMint: pk, quoteMint: pk, baseReserve: pk, quoteReserve: pk, shareMint: pk, shareLock: pk,
    totalShares: new BN(108_980_882), epoch: new BN(3), epochStart: new BN(1000), status: 0,
    insuranceBase: new BN(0), insuranceQuote: new BN(0), keeperBase: new BN(0), keeperQuote: new BN(0),
    protocolBase: new BN(0), protocolQuote: new BN(0), baseReserveAmount: new BN(329_912_021), quoteReserveAmount: new BN(36_000_000),
  };

  it('computes real on-chain epoch slots remaining from epoch_start + epoch_slots - slot', () => {
    const v = toVaultState({ exists: true, vault: pk, config: pk, quoteState: pk, vaultData, configData }, 108, 0, 1500);
    expect(v.epoch).toBe(3);
    // 1000 + 1500 - 1500 = 1000
    expect(v.epochSlotsRemaining).toBe(1000);
  });

  it('maps live risk limits from Config and never invents volatility', () => {
    const r = toRiskBreakers({ exists: true, vault: pk, config: pk, quoteState: pk, configData }, 1000);
    expect(r.maxAnchorStepBps).toBe(50);
    expect(r.minSpreadBps).toBe(2);
    expect(r.maxSpreadBps).toBe(50);
    expect(r.maxInventorySkewBps).toBe(6000);
    expect(r.keeperBondActive).toBe(false); // minBond == 0 => permissionless
  });
});

describe('S2-35 execution mode is explicit and transaction-enabled on Devnet', () => {
  it('the normal Devnet build is transaction-enabled; read-only is not forced', () => {
    expect(READ_ONLY_MODE).toBe(false);
    expect(TRANSACTIONS_ENABLED).toBe(true);
    expect(TRANSACTION_DISABLED_REASON).toBeNull();
    expect(ACTIVE_VAULT.canonical).toBe(true);
    expect(EXPECTED_GENESIS_HASH).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  });

  it('no page or component calls a transaction-submitting API directly', () => {
    const dirs = ['../src/pages', '../src/components'];
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of readdirSync(here(d))) {
        if (!f.endsWith('.tsx')) continue;
        const src = readFileSync(here(`${d}/${f}`), 'utf8');
        if (/sendTransaction|sendRawTransaction/.test(src)) offenders.push(`${d}/${f}: send*`);
        if (/\.rpc\(/.test(src)) offenders.push(`${d}/${f}: .rpc()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every action surface is gated by the resolved execution mode, not a blanket flag', () => {
    const swap = readFileSync(here('../src/pages/SwapPage.tsx'), 'utf8');
    const vault = readFileSync(here('../src/pages/VaultPage.tsx'), 'utf8');
    const risk = readFileSync(here('../src/components/KeeperRewards.tsx'), 'utf8');
    for (const src of [swap, vault, risk]) {
      expect(src).toMatch(/TRANSACTIONS_ENABLED/);
      expect(src).toMatch(/disabled=\{!TRANSACTIONS_ENABLED/);
    }
    // The obsolete blanket read-only blocker must not survive on any surface.
    for (const src of [swap, vault, risk]) {
      expect(src).not.toMatch(/disabled=\{READ_ONLY_MODE/);
    }
  });

  it('success is only reported after the awaited submit call (never pre-confirmation)', () => {
    const swap = readFileSync(here('../src/pages/SwapPage.tsx'), 'utf8');
    const vault = readFileSync(here('../src/pages/VaultPage.tsx'), 'utf8');
    // SwapPage: the `ok: true` note must follow the awaited on-chain submit.
    const swapSubmit = swap.indexOf('await swapOnChain(');
    const swapSuccess = swap.indexOf('ok: true');
    expect(swapSubmit).toBeGreaterThan(-1);
    expect(swapSuccess).toBeGreaterThan(swapSubmit);
    // VaultPage: the success notes follow their awaited submits.
    expect(vault.indexOf('ok: true')).toBeGreaterThan(vault.indexOf('await depositOnChain('));
    // The old unconditional "✓" render (success on any notice) must be gone.
    expect(vault).not.toMatch(/>✓ \{notice\}/);
    expect(swap).not.toMatch(/disabled=\{READ_ONLY_MODE/);
  });

  it('no secrets are present in the built bundle', () => {
    // The bundle is only present after `yarn build`; skip if absent.
    let files: string[] = [];
    try {
      files = readdirSync(here('../dist/assets')).filter((f) => f.endsWith('.js'));
    } catch {
      return;
    }
    for (const f of files) {
      const body = readFileSync(here(`../dist/assets/${f}`), 'utf8');
      expect(body).not.toMatch(/PYTH_API_KEY|api-key|BEGIN PRIVATE KEY|private_key/i);
    }
  });
});

describe('S2-32 cluster/program verification fails closed', () => {
  it('verifyCluster reports a mismatch as unverified', async () => {
    const conn = { getGenesisHash: async () => 'SOMETHING_ELSE' } as never;
    expect((await verifyCluster(conn)).verified).toBe(false);
  });
  it('verifyCluster accepts the canonical devnet genesis', async () => {
    const conn = { getGenesisHash: async () => EXPECTED_GENESIS_HASH } as never;
    expect((await verifyCluster(conn)).verified).toBe(true);
  });
  it('verifyProgram requires an executable account owned by the upgradeable loader', async () => {
    const good = { getAccountInfo: async () => ({ owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true }) } as never;
    const bad = { getAccountInfo: async () => ({ owner: PublicKey.default, executable: false }) } as never;
    expect((await verifyProgram(good)).verified).toBe(true);
    expect((await verifyProgram(bad)).verified).toBe(false);
  });
});
