import React, { useEffect, useState } from 'react';
import { loadLvrHistory, type LvrHistoryState } from '../data/lvrHistory';

/**
 * Compact LVR summary for the Vault page. Sourced from the published
 * `/analytics/lvr_history.json` artifact — never from the hardcoded
 * `vaultState.lvrAvoided7dUsd` zero. When a metric is unavailable it is shown
 * as "Unavailable", not as a misleading `+$0`.
 */
const fmtUsd = (v: number | null | undefined): string =>
  v === null || v === undefined ? 'Unavailable' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export const LvrSummaryCard: React.FC = () => {
  const [state, setState] = useState<LvrHistoryState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void loadLvrHistory().then((s) => { if (alive) setState(s); });
    return () => { alive = false; };
  }, []);

  const cardStyle: React.CSSProperties = {
    padding: '20px 22px', border: '1px solid rgba(255,255,255,0.08)',
    background: 'var(--uni-surface1)', borderRadius: 18,
  };

  let value: React.ReactNode = 'Unavailable';
  let sub = 'Modeled LVR history is not available in this deployment.';
  let badge = 'Unavailable';
  if (state.status === 'available') {
    const { data } = state;
    const arbswap = data.totals.arbswap_lvr_usd ?? null;
    if (arbswap !== null) {
      value = fmtUsd(arbswap);
      sub = `ArbSwap LVR over ${data.rows.length} modeled windows`;
      badge = 'Modeled';
    } else {
      // ArbSwap LVR is unavailable: show the modeled passive baseline instead,
      // clearly labelled, and state that ArbSwap LVR is not measured.
      value = fmtUsd(data.totals.passive_lvr_usd ?? null);
      sub = 'Passive baseline LVR (modeled) · ArbSwap LVR: Unavailable';
      badge = 'Modeled';
    }
  } else if (state.status === 'loading') {
    value = '…';
    sub = 'Loading LVR history…';
  }

  return (
    <div className="uni-card" style={cardStyle} data-testid="vault-lvr-summary">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>LVR (Modeled)</span>
        <span style={{ fontSize: 10, color: 'var(--uni-accent1)', background: 'rgba(0,229,176,0.1)', padding: '2px 6px', borderRadius: 4 }}>{badge}</span>
      </div>
      <p className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--uni-neutral1)', margin: '8px 0 4px' }}>{value}</p>
      <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>{sub}</span>
    </div>
  );
};

export default LvrSummaryCard;
