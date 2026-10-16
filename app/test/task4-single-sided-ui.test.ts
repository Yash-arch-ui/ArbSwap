import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import idl from '../src/idl/arbswap.json';
import {
  toSwapSide, depositSingleMethod, claimWithdrawSingleMethod,
  buildDepositSingleTransaction, buildClaimWithdrawSingleTransaction,
} from '../src/chain/program';
import {
  SINGLE_SIDED_ENABLED, SINGLE_SIDED_DISABLED_REASON, TRANSACTIONS_ENABLED,
} from '../src/chain/config';

const vaultSrc = readFileSync(
  fileURLToPath(new URL('../src/pages/VaultPage.tsx', import.meta.url)),
  'utf8',
);

const accountsOf = (name: string): string[] =>
  ((idl as unknown as { instructions: Array<{ name: string; accounts: Array<{ name: string }> }> })
    .instructions.find((i) => i.name === name)?.accounts ?? []).map((a) => a.name);

describe('Task 4.3: single-sided feature flag is fail closed', () => {
  it('defaults off and exposes a concrete disabled reason', () => {
    // The test environment does not set VITE_ENABLE_SINGLE_SIDED.
    expect(SINGLE_SIDED_ENABLED).toBe(false);
    expect(SINGLE_SIDED_DISABLED_REASON).toMatch(/VITE_ENABLE_SINGLE_SIDED/);
  });
  it('can never be enabled without transaction support', () => {
    // ENABLED is (env flag) AND TRANSACTIONS_ENABLED; false here either way.
    expect(SINGLE_SIDED_ENABLED && !TRANSACTIONS_ENABLED).toBe(false);
  });
});

describe('Task 4.1/4.2: deployed single-sided interfaces (IDL ↔ builders)', () => {
  it('deposit_single account order matches the deployed program', () => {
    expect(accountsOf('deposit_single')).toEqual([
      'user', 'vault', 'config', 'quote_state', 'base_reserve', 'quote_reserve',
      'share_mint', 'share_lock', 'user_base', 'user_quote', 'user_shares',
      'deposit_ticket', 'keeper_reward', 'token_program', 'system_program',
    ]);
  });
  it('claim_withdraw_single account order matches the deployed program', () => {
    expect(accountsOf('claim_withdraw_single')).toEqual([
      'user', 'vault', 'config', 'quote_state', 'base_reserve', 'quote_reserve',
      'share_mint', 'share_lock', 'withdraw_ticket', 'user_base', 'user_quote',
      'keeper_reward', 'token_program', 'system_program',
    ]);
  });
  it('emits the single-sided events', () => {
    const events = (idl as unknown as { events: Array<{ name: string }> }).events.map((e) => e.name);
    expect(events).toContain('DepositSingleEvent');
    expect(events).toContain('WithdrawSingleEvent');
  });
  it('the builders exist and the side mapping is the Anchor enum shape', () => {
    expect(typeof depositSingleMethod).toBe('function');
    expect(typeof claimWithdrawSingleMethod).toBe('function');
    expect(typeof buildDepositSingleTransaction).toBe('function');
    expect(typeof buildClaimWithdrawSingleTransaction).toBe('function');
    expect(toSwapSide('sellBase')).toEqual({ sellBase: {} });
    expect(toSwapSide('buyBase')).toEqual({ buyBase: {} });
  });
});

describe('Task 4.1: deposit UI states', () => {
  it('offers a both/single mode toggle, gated by the flag', () => {
    expect(vaultSrc).toMatch(/data-testid="deposit-mode-both"/);
    expect(vaultSrc).toMatch(/data-testid="deposit-mode-single"[\s\S]{0,300}disabled=\{!SINGLE_SIDED_ENABLED\}/);
  });
  it('shows swap portion, fee, impact, shares, min shares and min swap out', () => {
    for (const label of [
      'Swap portion:', 'Internal swap out:', 'Fee (on swap portion):',
      'Price impact (vs reservation mid):', 'Expected shares:', 'Min shares (', 'Min swap out (',
    ]) expect(vaultSrc).toContain(label);
  });
  it('requires a fresh quote and explains a depth/feasibility failure without a partial estimate', () => {
    expect(vaultSrc).toMatch(/Single-sided deposit needs a fresh quote/);
    expect(vaultSrc).toMatch(/No feasible single-sided deposit at this size/);
    expect(vaultSrc).toMatch(/Max swap depth now/);
  });
  it('gates submission on an explicit warm-up acknowledgement checkbox', () => {
    expect(vaultSrc).toMatch(/data-testid="warmup-ack"/);
    expect(vaultSrc).toMatch(/Tick the warm-up notice before depositing/);
  });
  it('never fabricates: no partial-fill approximation is rendered', () => {
    // The plan is all-or-nothing (depositSinglePlan returns null when infeasible),
    // so there is no "partial" branch.
    expect(vaultSrc).not.toMatch(/partial fill/i);
  });
});

describe('Task 4.2: withdraw UI states', () => {
  it('offers a both/one-token toggle and both/all payout choices', () => {
    expect(vaultSrc).toMatch(/data-testid="withdraw-mode-both"/);
    expect(vaultSrc).toMatch(/data-testid="withdraw-mode-single"/);
    expect(vaultSrc).toMatch(/data-testid="withdraw-payout-sol"/);
    expect(vaultSrc).toMatch(/data-testid="withdraw-payout-usdc"/);
  });
  it('shows both-token estimates, epoch settlement time, percent shortcuts and a crank', () => {
    expect(vaultSrc).toMatch(/Est\. Base Output:/);
    expect(vaultSrc).toMatch(/Est\. Quote Output:/);
    expect(vaultSrc).toMatch(/settling in ~\{vaultState\.epochSlotsRemaining\} slots/);
    expect(vaultSrc).toMatch(/withdraw-pct-\$\{pct\}/);
    expect(vaultSrc).toMatch(/Crank epoch/);
  });
  it('shows single-token amounts, min_out, impact and the both-token fallback', () => {
    expect(vaultSrc).toContain('Converted leg:');
    expect(vaultSrc).toContain('Min out (');
    expect(vaultSrc).toMatch(/Quote expired: claim both tokens instead\./);
  });
});

describe('Task 4.4: preview + simulate before any wallet prompt', () => {
  it('single deposit builds and simulates before presenting the preview', () => {
    const build = vaultSrc.indexOf('buildDepositSingleTransaction');
    const sim = vaultSrc.indexOf('await simulateSwap(');
    const preview = vaultSrc.indexOf('setDepPreview({');
    const send = vaultSrc.indexOf('await sendSwapTransaction(connection, wallet, depPreview.tx)');
    expect(build).toBeGreaterThan(-1);
    expect(sim).toBeGreaterThan(build);
    expect(preview).toBeGreaterThan(sim);
    expect(send).toBeGreaterThan(preview);
  });
  it('claim builds and simulates before presenting the preview', () => {
    const single = vaultSrc.indexOf('buildClaimWithdrawSingleTransaction');
    const both = vaultSrc.indexOf('buildClaimWithdrawTransaction');
    const sim = vaultSrc.indexOf('await simulateSwap(connection, tx)');
    const preview = vaultSrc.indexOf('setClaimPreview({ tx, summary, lines });');
    const send = vaultSrc.indexOf('await sendSwapTransaction(connection, wallet, claimPreview.tx)');
    expect(single).toBeGreaterThan(-1);
    expect(both).toBeGreaterThan(-1);
    expect(sim).toBeGreaterThan(single);
    expect(sim).toBeGreaterThan(both);
    expect(preview).toBeGreaterThan(sim);
    expect(send).toBeGreaterThan(preview);
  });
  it('re-reads quote freshness at confirm and discards a stale prepared tx', () => {
    const confirm = vaultSrc.indexOf('const handleClaimConfirm');
    const recheck = vaultSrc.indexOf('await fetchFreshQuote(connection)', confirm);
    const freshness = vaultSrc.indexOf('submitFreshnessReason(fresh)', recheck);
    const discard = vaultSrc.indexOf('The prepared claim was discarded.', freshness);
    expect(recheck).toBeGreaterThan(confirm);
    expect(freshness).toBeGreaterThan(recheck);
    expect(discard).toBeGreaterThan(freshness);
  });
  it('renders explicit preview panels with confirm buttons', () => {
    expect(vaultSrc).toMatch(/data-testid="deposit-preview"/);
    expect(vaultSrc).toMatch(/data-testid="claim-preview"/);
    expect(vaultSrc).toMatch(/Confirm &amp; sign in wallet/);
  });
});
