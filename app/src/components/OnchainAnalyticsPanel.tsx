import React, { useEffect, useState } from 'react';
import { loadOnchainAnalytics, type AnalyticsExportState } from '../data/onchainAnalytics';

/**
 * S2-25: optional historical on-chain analytics. Shows the export's snapshot
 * time, network, and indexed slot, and marks it STALE when old. Live state
 * (balances/quotes/reserves) is never sourced from here.
 */
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

  const body = (() => {
    switch (state.status) {
      case 'loading':
        return 'Loading on-chain analytics…';
      case 'missing':
        return 'No on-chain analytics export is available in this deployment (optional, historical only).';
      case 'malformed':
        return `On-chain analytics export is malformed: ${state.reason}.`;
      case 'error':
        return `On-chain analytics unavailable: ${state.reason}.`;
      case 'available': {
        const slot = state.data.index_status?.last_slot ?? 'n/a';
        const net = state.data.network ?? 'unknown';
        const age = Math.round(state.ageSeconds);
        return `Snapshot ${state.data.generated_at} (${age}s ago · network ${net} · indexed slot ${slot}).${
          state.stale ? ' STALE — historical only, not live.' : ''
        }`;
      }
    }
  })();

  return (
    <div className="glass-card" style={{ padding: 16, marginBottom: 16 }} role="status" aria-live="polite">
      <strong>On-chain analytics (historical, read-only)</strong>
      <p className="mono" style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--uni-neutral2)' }}>
        {body}
      </p>
      <p style={{ fontSize: 11, color: 'var(--uni-neutral2)', margin: '4px 0 0' }}>
        Live balances, quotes, and reserves are always read from Solana RPC, never from this export.
      </p>
    </div>
  );
};
