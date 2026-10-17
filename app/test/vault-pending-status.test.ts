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
