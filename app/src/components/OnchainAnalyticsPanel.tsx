import React, { useEffect, useState } from 'react';
import { loadOnchainAnalytics, type AnalyticsExportState, type IndexedEvent } from '../data/onchainAnalytics';
import { explorerTxUrl } from '../chain/config';

/**
 * S2-33: indexed on-chain history (confirmed program events collected by the
 * read-only indexer in `simulation/analytics`) plus a live protocol snapshot.
 *
 * Provenance is explicit and the three data classes are never mixed:
 *  - LIVE SNAPSHOT — account reads taken at export time;
 *  - INDEXED HISTORY — confirmed chain events in the exported coverage window;
 *  - RESEARCH — model/simulation outputs live on the Analytics page's artifact
 *    charts, not here.
 * Missing history is shown as a gap, never as zero activity.
 */

const fmtAtoms = (atoms: number | undefined, decimals: number, dp = 6): string =>
  typeof atoms === 'number' ? `${(atoms / 10 ** decimals).toFixed(dp)}` : 'n/a';

const fmtTime = (t: number | null | undefined): string => {
  if (typeof t !== 'number') return 'block_time unavailable';
  return new Date(t * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z');
};

const short = (s: string): string => `${s.slice(0, 6)}…${s.slice(-6)}`;

const SwapRow: React.FC<{ ev: IndexedEvent }> = ({ ev }) => {
  const p = ev.payload;
  const isBuy = p.side === 'buy';
  const inDec = isBuy ? 6 : 9; // buy: USDC in / WSOL out
  const outDec = isBuy ? 9 : 6;
  return (
    <tr>
      <td className="mono">{fmtTime(ev.block_time)}</td>
      <td className="mono">{ev.slot}</td>
      <td>
        <span className={`badge ${isBuy ? 'badge-fresh' : 'badge-neutral'}`}>
          {isBuy ? 'Buy WSOL' : 'Sell WSOL'}
        </span>
      </td>
      <td className="mono">{fmtAtoms(p.amount_in, inDec)}</td>
      <td className="mono">{fmtAtoms(p.amount_out, outDec)}</td>
      <td className="mono">{fmtAtoms(p.fee, inDec, 6)}</td>
      <td className="mono">v{p.version ?? '?'}</td>
      <td className="mono">
        <a href={explorerTxUrl(ev.signature)} target="_blank" rel="noreferrer">{short(ev.signature)}</a>
      </td>
    </tr>
  );
};

export const OnchainAnalyticsPanel: React.FC = () => {
  const [state, setState] = useState<AnalyticsExportState>({ status: 'loading' });

  useEffect(() => {
    let ok = true;
    void loadOnchainAnalytics().then((s) => {
      if (ok) setState(s);
    });
    return () => {
      ok = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <Panel title="On-chain history (indexed, read-only)">
        <p className="mono" style={{ fontSize: 12 }}>Loading indexed history…</p>
      </Panel>
    );
  }
  if (state.status === 'missing') {
    return (
      <Panel title="On-chain history (indexed, read-only)">
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>
          Historical analytics unavailable — no <code>/analytics/onchain.json</code> export is served in
          this deployment. This is a gap, not zero activity. Regenerate with
          <code> python -m simulation.analytics sync</code>.
        </p>
      </Panel>
    );
  }
  if (state.status === 'malformed') {
    return (
      <Panel title="On-chain history (indexed, read-only)">
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-warning)' }}>
          Historical analytics malformed: {state.reason}.
        </p>
      </Panel>
    );
  }
  if (state.status === 'error') {
    return (
      <Panel title="On-chain history (indexed, read-only)">
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-warning)' }}>
          Historical analytics unavailable: {state.reason}.
        </p>
      </Panel>
    );
  }

  const d = state.data;
  const hist = d.history;
  const cov = hist?.coverage ?? d.index_status?.coverage;
  const fresh = d.freshness;
  const trading = d.trading;
  const age = Math.round(state.ageSeconds);

  return (
    <Panel title="On-chain history (indexed, read-only)">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="badge badge-fresh mono">INDEXED HISTORY</span>
        <span className="badge badge-neutral mono">LIVE SNAPSHOT</span>
        {state.stale && <span className="badge badge-critical mono">STALE EXPORT ({age}s old)</span>}
      </div>

      <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>
        Snapshot {d.generated_at} ({age}s ago · network {d.network ?? 'unknown'}).
        {cov ? ` Indexed coverage: slots ${cov.first_slot}–${cov.last_slot} (${cov.transactions} txs, ${cov.events} events).` : ''}
        {d.index_status?.last_indexed_at ? ` Last successful indexing: ${d.index_status.last_indexed_at}.` : ''}
        {state.stale ? ' STALE — historical only, not live.' : ''}
      </p>

      {/* Live snapshot (distinct from indexed history) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, margin: '12px 0' }}>
        <Metric label="Quote version (live)" value={fresh?.quote_version != null ? `v${fresh.quote_version}` : 'n/a'} />
        <Metric
          label="Quote status (live)"
          value={fresh?.quote_expired === true ? 'EXPIRED' : fresh?.quote_expired === false ? 'fresh' : 'n/a'}
          tone={fresh?.quote_expired === true ? 'var(--uni-warning)' : undefined}
        />
        <Metric label="Current slot @ export" value={fresh?.current_slot != null ? String(fresh.current_slot) : 'n/a'} />
        <Metric label="Quote expiry slot" value={fresh?.quote_expiry_slot != null ? String(fresh.quote_expiry_slot) : 'n/a'} />
        <Metric label="Indexed swaps" value={hist ? String(hist.swaps.length) : 'n/a'} />
        <Metric label="Indexed deposits" value={hist ? String(hist.deposits.length) : 'n/a'} />
        <Metric label="Indexed withdrawals" value={hist ? String(hist.withdrawals.length) : 'n/a'} />
        <Metric label="Quote commits (indexed)" value={hist ? `${hist.quote_commits.length}${hist.quote_commits_truncated ? ` +${hist.quote_commits_truncated}` : ''}` : 'n/a'} />
        <Metric label="Failed txs (coverage)" value={trading?.failed_transactions != null ? String(trading.failed_transactions) : 'n/a'} tone="var(--uni-warning)" />
      </div>

      {/* Historical swaps (indexed confirmed events) */}
      <h4 className="mono" style={{ fontSize: 12, margin: '10px 0 6px' }}>Historical swaps (indexed)</h4>
      {hist && hist.swaps.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="mono" style={{ fontSize: 11, width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--uni-neutral2)' }}>
                <th>Time (UTC)</th><th>Slot</th><th>Side</th><th>In</th><th>Out</th><th>Fee</th><th>Quote</th><th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {hist.swaps.map((ev) => <SwapRow key={`${ev.signature}-${ev.slot}`} ev={ev} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>
          No swaps in the indexed coverage window (a gap, not zero activity).
        </p>
      )}

      {/* Deposits / withdrawals */}
      <h4 className="mono" style={{ fontSize: 12, margin: '14px 0 6px' }}>Deposits &amp; withdrawals (indexed)</h4>
      {hist && hist.deposits.length > 0 ? (
        <ul className="mono" style={{ fontSize: 11, color: 'var(--uni-neutral2)', paddingLeft: 18 }}>
          {hist.deposits.map((ev) => (
            <li key={ev.signature}>
              Deposit {fmtTime(ev.block_time)} · {fmtAtoms(ev.payload.base_amount, 9)} WSOL + {fmtAtoms(ev.payload.quote_amount, 6)} USDC → {ev.payload.shares ?? '?'} shares ·{' '}
              <a href={explorerTxUrl(ev.signature)} target="_blank" rel="noreferrer">{short(ev.signature)}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>No deposits in coverage window.</p>
      )}
      {hist && hist.withdrawals.length > 0 ? (
        <ul className="mono" style={{ fontSize: 11, color: 'var(--uni-neutral2)', paddingLeft: 18 }}>
          {hist.withdrawals.map((ev) => (
            <li key={ev.signature}>Withdrawal {fmtTime(ev.block_time)} · {ev.payload.shares ?? '?'} shares</li>
          ))}
        </ul>
      ) : (
        <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>No withdrawals indexed (none executed, or outside coverage).</p>
      )}

      <p style={{ fontSize: 11, color: 'var(--uni-neutral2)', marginTop: 10 }}>
        {hist?.quote_attribution_note ??
          'Quote attribution (keeper) is not reconstructable from events; only the live QuoteState keeper is shown.'}
      </p>
      <p style={{ fontSize: 11, color: 'var(--uni-neutral2)', marginTop: 4 }}>
        Live balances, quotes and reserves are always read from Solana RPC, never from this export. The
        model/markout charts above are RESEARCH artifacts (offline simulation), not indexed chain history.
      </p>
    </Panel>
  );
};

const Metric: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div style={{ background: 'var(--uni-surface2)', borderRadius: 10, padding: '8px 10px' }}>
    <div className="mono" style={{ fontSize: 10, color: 'var(--uni-neutral2)', textTransform: 'uppercase' }}>{label}</div>
    <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: tone }}>{value}</div>
  </div>
);

const Panel: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="glass-card" style={{ padding: 16, marginBottom: 16 }} role="status" aria-live="polite" data-testid="onchain-history-panel">
    <strong>{title}</strong>
    <div style={{ marginTop: 8 }}>{children}</div>
  </div>
);
