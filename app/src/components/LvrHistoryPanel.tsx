import React, { useEffect, useState } from 'react';
import {
  loadLvrHistory, LVR_ARTIFACT_PATH,
  type LvrHistoryState, type LvrRow,
} from '../data/lvrHistory';

/**
 * Public LVR transparency panel (see `docs/PUBLIC_LVR_TRANSPARENCY_PLAN.md`).
 *
 * Shows the modeled passive-AMM baseline LVR and modeled gross fees per replay
 * window. ArbSwap realized LVR is **unavailable** and is shown as such — a 2 s
 * markout proxy is displayed separately and is never relabeled as LVR. Missing
 * data is never rendered as zero.
 */

const fmtUsd = (v: number | null): string =>
  v === null ? 'Unavailable' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined ? 'Unavailable' : `${v.toFixed(1)}%`;

const statusLabel = (s: LvrRow['status']): string =>
  s === 'on-chain-verified' ? 'On-chain verified' : s === 'indexed' ? 'Indexed' : 'Modeled';

const statusBadgeClass = (s: LvrRow['status']): string =>
  s === 'on-chain-verified' ? 'badge badge-fresh' : s === 'indexed' ? 'badge badge-warning' : 'badge badge-neutral';

// One consistent user-facing label + the exact formula (per the final review).
const E1_LABEL = 'Modeled E1: Hedged-PnL Improvement vs Passive Baseline';
const E1_FORMULA = '(ArbSwap hedged PnL − passive baseline hedged PnL) / abs(passive baseline hedged PnL) × 100';
// Presentation-only annotation for the known denominator-sensitive outlier (W5).
// The passive-baseline hedged PnL is not carried in the published artifact, so the
// value is stated here rather than recomputed in the UI. No artifact value is changed.
const E1_OUTLIER_NOTES: Record<string, string> = {
  W5: 'Denominator-sensitive outlier: the passive-baseline hedged PnL is ≈ $193.89, so a small denominator yields a very large percentage.',
};

function Panel({ children, testid }: { children: React.ReactNode; testid: string }): React.ReactElement {
  return (
    <div className="glass-card" role="status" aria-live="polite" data-testid={testid}
      style={{ padding: 20, marginBottom: 24 }}>
      {children}
    </div>
  );
}

function Note({ text }: { text: string }): React.ReactElement {
  return <p style={{ color: 'var(--uni-warning)', fontSize: 13, margin: '8px 0 0' }}>{text}</p>;
}

/** Grouped-bar chart: passive baseline LVR vs modeled fees, per period. */
function LvrBars({ rows }: { rows: LvrRow[] }): React.ReactElement {
  const W = 640, H = 200, padL = 44, padR = 12, padT = 12, padB = 46;
  const max = Math.max(1, ...rows.flatMap((r) => [r.passiveLvrUsd ?? 0, r.feesUsd ?? 0]));
  const slot = (W - padL - padR) / rows.length;
  const barW = Math.min(26, slot / 3);
  const y = (v: number): number => padT + (H - padT - padB) * (1 - v / max);
  const gridVals = [0, 0.5, 1].map((f) => max * f);
  return (
    <div className="svg-chart-wrapper" style={{ padding: 12, borderRadius: 14 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label="Modeled passive baseline LVR and vault fees per replay window">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.08)" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="var(--uni-neutral3)">
              ${Math.round(v).toLocaleString()}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = padL + slot * i + slot / 2;
          const passive = r.passiveLvrUsd ?? 0;
          const fees = r.feesUsd ?? 0;
          return (
            <g key={r.label}>
              <rect x={cx - barW - 2} y={y(passive)} width={barW} height={y(0) - y(passive)} rx={3} fill="#ff593c">
                <title>{`${r.label} passive baseline LVR (modeled): ${fmtUsd(r.passiveLvrUsd)}`}</title>
              </rect>
              <rect x={cx + 2} y={y(fees)} width={barW} height={y(0) - y(fees)} rx={3} fill="#00e5b0">
                <title>{`${r.label} gross modeled fees: ${fmtUsd(r.feesUsd)}`}</title>
              </rect>
              <text x={cx} y={H - padB + 16} textAnchor="middle" fontSize={10} fill="var(--uni-neutral2)">
                {r.label}
              </text>
              <text x={cx} y={H - padB + 30} textAnchor="middle" fontSize={9} fill="var(--uni-neutral3)">
                {r.date}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, marginTop: 4 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#ff593c', borderRadius: 2, marginRight: 6 }} />Passive baseline LVR (modeled)</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#00e5b0', borderRadius: 2, marginRight: 6 }} />Vault fees (modeled, gross)</span>
        <span style={{ color: 'var(--uni-neutral3)' }}>ArbSwap LVR: Unavailable (not plotted)</span>
      </div>
    </div>
  );
}

function Content({ state }: { state: LvrHistoryState }): React.ReactElement {
  if (state.status === 'loading') return <Panel testid="lvr-history-panel"><Note text="Loading LVR history…" /></Panel>;
  if (state.status === 'missing') {
    return <Panel testid="lvr-history-panel">
      <h3 style={{ margin: 0, fontSize: 16 }}>LVR History</h3>
      <Note text="LVR history unavailable: no /analytics/lvr_history.json artifact is served in this deployment. This is a data gap, not zero activity." />
    </Panel>;
  }
  if (state.status === 'malformed') {
    return <Panel testid="lvr-history-panel">
      <h3 style={{ margin: 0, fontSize: 16 }}>LVR History</h3>
      <Note text={`LVR history artifact is invalid: ${state.reason}.`} />
    </Panel>;
  }
  if (state.status === 'error') {
    return <Panel testid="lvr-history-panel">
      <h3 style={{ margin: 0, fontSize: 16 }}>LVR History</h3>
      <Note text={`LVR history unavailable: ${state.reason}.`} />
    </Panel>;
  }

  const { data, ageSeconds, stale } = state;
  const modeled = data.rows.every((r) => r.status === 'modeled');
  const arbswapUnavailable = data.rows.every((r) => r.arbswapLvrUsd === null);
  const netUnavailable = data.rows.every((r) => r.netLpImpactUsd === null);
  return (
    <Panel testid="lvr-history-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>LVR History</h3>
        <span className={statusBadgeClass(modeled ? 'modeled' : 'indexed')}>{modeled ? 'Modeled' : 'Mixed'}</span>
      </div>
      <p style={{ color: 'var(--uni-neutral2)', fontSize: 12, margin: '6px 0 12px' }}>
        Benchmark: <span className="mono">{data.benchmark}</span> · markout horizon {data.markoutSeconds}s ·
        generated {data.generatedAt}{stale ? ' (stale)' : ''} · age {Math.round(ageSeconds)}s
      </p>

      <LvrBars rows={data.rows} />

      <table style={{ width: '100%', fontSize: 12, marginTop: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--uni-neutral2)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left' }}>Period</th><th>Swaps</th><th>Volume (USD)</th>
            <th>Passive LVR</th><th>ArbSwap LVR</th><th>{E1_LABEL}</th><th>Fees (gross)</th><th>Net LP impact</th><th>Cov.</th><th>Status</th>
          </tr>
        </thead>
        <tbody className="mono">
          {data.rows.map((r) => (
            <tr key={r.label} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <td style={{ textAlign: 'left' }}>{r.label} · {r.periodStart}</td>
              <td style={{ textAlign: 'right' }}>{r.swaps.toLocaleString()}</td>
              <td style={{ textAlign: 'right' }}>${r.volumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td style={{ textAlign: 'right' }}>{fmtUsd(r.passiveLvrUsd)}</td>
              <td style={{ textAlign: 'right', color: 'var(--uni-neutral3)' }}>{fmtUsd(r.arbswapLvrUsd)}</td>
              <td style={{ textAlign: 'right' }}>
                {fmtPct(r.lvrReductionPct)}
                {E1_OUTLIER_NOTES[r.label] && (
                  <span title={E1_OUTLIER_NOTES[r.label]} aria-label={E1_OUTLIER_NOTES[r.label]}
                    style={{ marginLeft: 4, color: 'var(--uni-warning)', cursor: 'help' }}>⚠</span>
                )}
              </td>
              <td style={{ textAlign: 'right' }}>{fmtUsd(r.feesUsd)}</td>
              <td style={{ textAlign: 'right', color: 'var(--uni-neutral3)' }}>{fmtUsd(r.netLpImpactUsd)}</td>
              <td style={{ textAlign: 'right' }}>{(r.coverageBps / 100).toFixed(0)}%</td>
              <td style={{ textAlign: 'right' }}>{statusLabel(r.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ color: 'var(--uni-neutral3)', fontSize: 12, marginTop: 8 }}>
        Totals — passive baseline LVR {fmtUsd(data.totals.passive_lvr_usd ?? null)};
        gross fees {fmtUsd(data.totals.fees_usd ?? null)};
        ArbSwap LVR {fmtUsd(data.totals.arbswap_lvr_usd ?? null)};
        net LP impact {fmtUsd(data.totals.net_lp_impact_usd ?? null)}.
        {E1_LABEL} is shown per row (no headline mean).
      </p>

      <Note text={`${E1_LABEL} is denominator-sensitive: a small passive-baseline hedged PnL can produce a very large percentage. These modeled values are not LVR reduction or a profitability guarantee.`} />

      {data.rows.filter((r) => E1_OUTLIER_NOTES[r.label]).map((r) => (
        <p key={r.label} style={{ color: 'var(--uni-warning)', fontSize: 12, margin: '6px 0 0' }}>
          {r.label} {fmtPct(r.lvrReductionPct)} — {E1_OUTLIER_NOTES[r.label]}
        </p>
      ))}

      {(arbswapUnavailable || netUnavailable) && (
        <Note text={
          (arbswapUnavailable ? data.unavailable.arbswap_lvr_usd ?? 'ArbSwap LVR unavailable. ' : '')
          + (netUnavailable ? ` ${data.unavailable.net_lp_impact_usd ?? ''}` : '')
        } />
      )}

      <details style={{ marginTop: 12, fontSize: 12, color: 'var(--uni-neutral2)' }}>
        <summary style={{ cursor: 'pointer' }}>Methodology &amp; limitations</summary>
        <ul style={{ margin: '8px 0 0 18px', lineHeight: 1.7 }}>
          {data.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
        <p style={{ margin: '8px 0 0' }}>
          A 2s execution markout is an adverse-selection <em>proxy</em>, not LVR; it is shown as
          <span className="mono"> arbswap_markout_2s_bps</span> and is never labeled as LVR.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>{E1_LABEL}</strong> is a <em>modeled, relative</em> hedged-PnL comparison:
          <span className="mono"> {E1_FORMULA}</span>. It is <strong>not</strong> an LVR amount and
          <strong> not</strong> a measured percentage reduction in LVR. The result is sensitive to the
          magnitude of the passive baseline (a small denominator inflates the percentage), and ArbSwap
          and the passive baseline may execute different volumes — so this comparison does not establish
          apples-to-apples profitability or prove that ArbSwap outperforms real-world passive AMMs.
        </p>
      </details>

      <p style={{ marginTop: 12, fontSize: 12 }}>
        <a className="mono" href={LVR_ARTIFACT_PATH} download style={{ color: 'var(--uni-accent1)' }}>
          Download the exact artifact ({LVR_ARTIFACT_PATH})
        </a>
      </p>
    </Panel>
  );
}

export const LvrHistoryPanel: React.FC = () => {
  const [state, setState] = useState<LvrHistoryState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void loadLvrHistory().then((s) => { if (alive) setState(s); });
    return () => { alive = false; };
  }, []);
  return <Content state={state} />;
};

export default LvrHistoryPanel;
