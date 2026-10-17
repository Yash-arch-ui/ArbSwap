import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression test for the Vault pending-status UI fix (ported from volatility
// `1e17dcd`). The prior UI collapsed "in flight" and "failed" into a single
// boolean, so a transaction that was still awaiting a wallet signature rendered
// the red "✕ Request Failed" card before it had a chance to land. The fix uses an
// explicit NoticeStatus. Source-level assertions are the convention in this repo
// (there is no React DOM test harness).
const vaultSrc = readFileSync(
  fileURLToPath(new URL('../src/pages/VaultPage.tsx', import.meta.url)),
  'utf8',
);

describe('Vault status UI: pending, success, cancelled and error are distinct', () => {
  it('models notice status explicitly rather than a success/failure boolean', () => {
    expect(vaultSrc).toMatch(/type NoticeStatus = 'pending' \| 'success' \| 'cancelled' \| 'error'/);
    expect(vaultSrc).toMatch(/useState<\{ text: string; status: NoticeStatus \} \| null>/);
    // The old boolean shape must be gone.
    expect(vaultSrc).not.toMatch(/notice\.ok/);
    expect(vaultSrc).not.toMatch(/useState<\{ text: string; ok: boolean \}/);
  });

  it('renders every branch from notice.status (never a boolean)', () => {
    expect(vaultSrc).toMatch(/notice\.status === 'pending'/);
    expect(vaultSrc).toMatch(/notice\.status === 'success'/);
    expect(vaultSrc).toMatch(/notice\.status === 'cancelled'/);
    expect(vaultSrc).toMatch(/role=\{notice\.status === 'success' \|\| notice\.status === 'pending' \? 'status' : 'alert'\}/);
  });

  it('shows a neutral in-flight header that never claims confirmation or failure', () => {
    // The pending label must not read as a confirmed or failed outcome.
    expect(vaultSrc).toMatch(/notice\.status === 'pending'\s*\?\s*'◌ Submitting…'/);
    expect(vaultSrc).not.toMatch(/notice\.status === 'pending'\s*\?\s*'✓/);
    expect(vaultSrc).not.toMatch(/notice\.status === 'pending'\s*\?\s*'✕/);
  });

  it('writes in-flight notices with the pending status', () => {
    for (const text of [
      'Simulating deposit before signing…',
      'Queueing withdrawal… Awaiting wallet signature and confirmation.',
      'Advancing epoch (crank)… Awaiting wallet signature and confirmation.',
    ]) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(vaultSrc).toMatch(new RegExp(`text: '${escaped}', status: 'pending'`));
    }
  });

  it('only sets success after the awaited on-chain submit resolves', () => {
    const send = vaultSrc.indexOf('await sendSwapTransaction(connection, wallet, depPreview.tx)');
    const success = vaultSrc.indexOf("status: 'success'");
    expect(send).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(send);
  });

  it('classifies a rejected/cancelled wallet request as cancelled, not error', () => {
    expect(vaultSrc).toMatch(/const cancelled = \/user rejected\|rejected the request\|declined\|cancel\/i\.test\(msg\)/);
    expect(vaultSrc).toMatch(/status: cancelled \? 'cancelled' : 'error'/);
  });

  it('guards every submitting handler against re-entry while a request is in flight', () => {
    for (const handler of [
      'runDepositConfirm',
      'handleWithdraw',
      'handleCrank',
      'handleClaimPreview',
      'handleClaimConfirm',
    ]) {
      const start = vaultSrc.indexOf(`const ${handler} = async`);
      expect(start, `${handler} must exist`).toBeGreaterThan(-1);
      const body = vaultSrc.slice(start, start + 400);
      expect(body, `${handler} must re-check an in-flight flag`).toMatch(/if \(isWorking\) return;|if \(isWorking \|\| isClaiming\) return;|if \(isClaiming\) return;/);
    }
  });

  it('refreshes the blockhash and revalidates freshness before a stale preview is signed', () => {
    // The single-sided deposit confirm must re-read the quote and discard a
    // stale prepared transaction (mirroring the claim confirm).
    const define = vaultSrc.indexOf('const runDepositConfirm');
    const fetchFresh = vaultSrc.indexOf('await fetchFreshQuote(connection)', define);
    const discard = vaultSrc.indexOf('The prepared deposit was discarded.', fetchFresh);
    const blockhash = vaultSrc.indexOf('recentBlockhash = (await connection.getLatestBlockhash', define);
    expect(fetchFresh).toBeGreaterThan(define);
    expect(discard).toBeGreaterThan(fetchFresh);
    expect(blockhash).toBeGreaterThan(define);
  });
});

describe('Vault transaction reliability hardening', () => {
  it('fails closed unless the RPC endpoint is verified as Devnet at runtime', () => {
    // The build-time cluster check is not sufficient on its own; the vault path
    // must also require the runtime genesis verification (as the swap path does).
    expect(vaultSrc).toMatch(/genesisVerified/);
    const blocked = vaultSrc.slice(vaultSrc.indexOf('const blocked = ()'), vaultSrc.indexOf('const blocked = ()') + 500);
    expect(blocked).toMatch(/if \(!genesisVerified\)/);
    // The single-sided preview must also check it.
    expect(vaultSrc).toMatch(/if \(!genesisVerified\) \{ setNotice/);
  });

  it('re-simulates a prepared transaction against live state before signing it', () => {
    // Both confirm handlers must re-simulate after refreshing the blockhash and
    // discard the tx if it no longer simulates (state/quote moved).
    for (const [confirm, sendExpr] of [
      ['runDepositConfirm', 'await sendSwapTransaction(connection, wallet, depPreview.tx)'],
      ['handleClaimConfirm', 'await sendSwapTransaction(connection, wallet, claimPreview.tx)'],
    ] as const) {
      const start = vaultSrc.indexOf(`const ${confirm}`);
      expect(start, `${confirm} must exist`).toBeGreaterThan(-1);
      const body = vaultSrc.slice(start, vaultSrc.indexOf(sendExpr, start));
      expect(body, `${confirm} must re-simulate before send`).toMatch(/const sim = await simulateSwap\(connection, (depPreview|claimPreview)\.tx\)/);
      expect(body, `${confirm} must discard a failing re-simulation`).toMatch(/no longer simulates/);
    }
  });

  it('invalidates an in-flight preview when the user changes an input', () => {
    // A stale async preview must not overwrite newer UI state.
    expect(vaultSrc).toMatch(/const requestSeq = useRef\(0\)/);
    expect(vaultSrc).toMatch(/const invalidatePreviews = \(\) => \{\s*requestSeq\.current \+= 1;/);
    // Inputs and mode/side toggles invalidate rather than only clearing one preview.
    expect(vaultSrc).toMatch(/setDepositSol\(e\.target\.value\);\s*invalidatePreviews\(\)/);
    expect(vaultSrc).toMatch(/setDepositUsdc\(e\.target\.value\);\s*invalidatePreviews\(\)/);
    expect(vaultSrc).toMatch(/setDepositSingleAmount\(e\.target\.value\); invalidatePreviews\(\)/);
    expect(vaultSrc).toMatch(/setWithdrawShares\(e\.target\.value\); invalidatePreviews\(\)/);
    // Preview handlers take a sequence number and guard before applying results.
    expect(vaultSrc).toMatch(/const seq = \+\+requestSeq\.current;/);
    expect(vaultSrc).toMatch(/if \(seq !== requestSeq\.current\) return;/);
  });
});
