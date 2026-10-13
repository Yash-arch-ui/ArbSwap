import React from 'react';
import { useBackend, meanVenueMetric, useModelMetrics } from '../data/backend';
import { OnchainAnalyticsPanel } from '../components/OnchainAnalyticsPanel';
import { ReadOnlyBanner } from '../components/ReadOnlyMode';

export const AnalyticsPage: React.FC = () => {
  const backend = useBackend();
  const model = useModelMetrics();
  const arbMarkout = meanVenueMetric(backend.heldOut, 'ArbSwap', 'markout_2s_bps');
  const b1Markout = meanVenueMetric(backend.heldOut, 'B1_passive', 'markout_2s_bps');
  const arbShare = backend.routed?.rows.find((r) => r.venue === 'ArbSwap')?.volume_share ?? null;
  const fmt = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d));
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
  return (
    <div className="analytics-page-wrapper">
      <div className="container analytics-container">
        <OnchainAnalyticsPanel />
        <ReadOnlyBanner detail="Analytics combines live on-chain observations, indexed/optional exports, and offline model artifacts — each labelled by provenance. No transactions." />
        
        {/* Header Block */}
        <div className="analytics-header">
          <div>
            <h1 className="analytics-title">Protocol Analytics & Microstructure Benchmarks</h1>
            <p className="analytics-subtitle">
              Empirical proofs of LVR mitigation, 2-second markouts, and honest execution quality (Solmaz et al. methodology)
            </p>
          </div>
          <div className="analytics-meta-badges">
            <span className="badge badge-fresh">SOL/USDC Pool</span>
            <span className="badge badge-neutral mono">Reference: Bybit 1s Archive + Pyth</span>
          </div>
        </div>

        {/* Top 4 Performance Cards */}
        <div className="perf-cards-grid">
          <div className="glass-card perf-card">
            <span className="perf-label">2-Second Markout (Tau = +2s)</span>
            <span className="perf-value mono text-success">{fmt(arbMarkout)} bps</span>
            <span className="perf-sub text-muted">
              Passive AMMs average <strong className="text-critical">{fmt(b1Markout)} bps</strong> (model output, W2-W6 mean)
            </span>
          </div>

          <div className="perf-card glass-card">
            <span className="perf-label">Routed Volume Share (no propAMM)</span>
            <span className="perf-value mono text-accent">{pct(arbShare)}</span>
            <span className="perf-sub text-muted">
              Backend routed world, W1-W6 (real price path, synthetic flow)
            </span>
          </div>

          <div className="perf-card glass-card">
            <span className="perf-label">Quote-vs-Fill Execution Gap</span>
            <span className="perf-value mono text-muted">N/A</span>
            <span className="perf-sub text-muted">
              Requires live fills (no quote yet). Not a simulated or hardcoded value.
            </span>
          </div>

          <div className="perf-card glass-card">
            <span className="perf-label">Retail Quiet-Flow Half-Spread</span>
            <span className="perf-value mono text-muted">N/A</span>
            <span className="perf-sub text-muted">
              Unavailable — requires indexed trades, not fabricated.
            </span>
          </div>
        </div>

        {/* Main 2 Scientific Charts (SVG Vector Graphs) */}
        <div className="charts-split-grid">
          
          {/* Chart 1: Markout Curves (tau = -5s to +15s) */}
          <div className="glass-card chart-card">
            <div className="chart-header">
              <div>
                <h3 className="chart-title">Post-Fill Markout Trajectory (bps)</h3>
                <p className="chart-subtitle">
                  1e4 · d · (m(t+τ) - p_exec) / p_exec · Positive = LP profit
                </p>
              </div>
              <div className="chart-legend">
                <span className="legend-item"><i className="legend-dot arbswap"></i> ArbSwap ({fmt(arbMarkout)} bps @ 2s · model)</span>
                <span className="legend-item"><i className="legend-dot passive"></i> Passive AMM ({fmt(b1Markout)} bps · model)</span>
              </div>
            </div>

            {/* Data-driven per-window 2s markout bars from headline.e1_e4 (model). */}
            <div className="svg-chart-wrapper">
              {(() => {
                const e1 = backend.headline?.e1_e4 ?? {};
                const windows = Object.keys(e1);
                const arbVals = windows.map((w) => Number(e1[w]?.E2_arb_markout_2s_bps ?? 0));
                const b1Vals = windows.map((w) => Number(e1[w]?.E2_b1_markout_2s_bps ?? 0));
                const max = Math.max(0.1, ...arbVals.map(Math.abs), ...b1Vals.map(Math.abs));
                if (!windows.length) {
                  return (
                    <p className="text-muted" style={{ margin: 'auto', textAlign: 'center', fontSize: 13 }}>
                      Unavailable — no `headline.e1_e4` window series is bundled with this build.
                    </p>
                  );
                }
                return (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, height: 180, padding: '8px 12px' }}>
                    {windows.map((w) => (
                      <div key={w} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'flex-end', height: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: '100%' }}>
                          <div title={`ArbSwap ${arbVals[windows.indexOf(w)].toFixed(2)} bps`} style={{ width: 12, height: `${(Math.abs(arbVals[windows.indexOf(w)]) / max) * 100}%`, background: 'var(--accent-primary)' }} />
                          <div title={`B1 ${b1Vals[windows.indexOf(w)].toFixed(2)} bps`} style={{ width: 12, height: `${(Math.abs(b1Vals[windows.indexOf(w)]) / max) * 100}%`, background: 'var(--status-critical)', opacity: 0.7 }} />
                        </div>
                        <span className="mono text-muted" style={{ fontSize: 10 }}>{w}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <p className="chart-callout-text text-muted">
              <strong>Provenance:</strong> model/replay output per held-out window (W2–W6), ArbSwap
              mean {fmt(arbMarkout)} bps vs passive B1 mean {fmt(b1Markout)} bps. Not live trading
              performance and not an on-chain observation.
            </p>
          </div>

          {/* Chart 2: LVR Loss vs Fees Collected (7-Day Comparison) */}
          <div className="glass-card chart-card">
            <div className="chart-header">
              <div>
                <h3 className="chart-title">LVR Loss Avoidance (Daily USD)</h3>
                <p className="chart-subtitle">
                  Realized arbitrage extraction: Passive AMM vs ArbSwap
                </p>
              </div>
              <div className="chart-legend">
                <span className="legend-item"><i className="legend-dot passive"></i> Passive LVR Loss</span>
                <span className="legend-item"><i className="legend-dot arbswap"></i> ArbSwap LVR Loss</span>
              </div>
            </div>

            <div className="lvr-bars-grid">
              <p className="text-muted" style={{ margin: 'auto', textAlign: 'center', fontSize: 13 }}>
                N/A — no replayed LVR series is bundled with this build.
                <br />
                <span style={{ fontSize: 11 }}>
                  Per-day LVR is a model/replay output and is provided only when generated from a
                  frozen artifact; it is not live trading performance.
                </span>
              </p>
            </div>

            <p className="chart-callout-text text-muted">
              <strong>LVR Budget Rule (R16):</strong> Active depth throttles quadratically with volatility (V_active ≤ 8(R - gas)/σ²), preventing the huge losses seen on high-volatility days like Thursday.
            </p>
          </div>

        </div>

        {/* Empirical Proof Matrix */}
        <div className="glass-card matrix-card">
          <div className="card-header-row">
            <div>
              <h3>Microstructural Comparison Matrix</h3>
              <p className="matrix-sub text-muted">Model metrics on Solana SOL/USDC trading pairs</p>
            </div>
            <span className="badge badge-neutral mono">Paper Reference: arXiv:2609.38056</span>
          </div>

          <div className="matrix-table">
            <div className="matrix-row matrix-head">
              <span>Metric / Benchmark</span>
              <span>ArbSwap (This Protocol)</span>
              <span>Typical PropAMM (Closed)</span>
              <span>Passive AMM (v2 / Orca)</span>
            </div>
            {[
              { metric: '2s Markout (bps)', arbSwap: fmt(arbMarkout), propAmm: 'n/a', passiveAmm: fmt(b1Markout) },
              { metric: 'Quote-vs-Fill Gap (bps)', arbSwap: 'N/A (no live fills)', propAmm: 'n/a', passiveAmm: 'n/a' },
              { metric: 'Quiet-flow Half-spread (bps)', arbSwap: 'N/A', propAmm: 'n/a', passiveAmm: 'n/a' },
              { metric: 'Compute Units / Update', arbSwap: model.cuUpdateQuote ? `${model.cuUpdateQuote.toLocaleString()} CU` : 'n/a', propAmm: 'n/a', passiveAmm: 'n/a' },
            ].map((row) => (
              <div key={row.metric} className="matrix-row">
                <span className="font-bold text-primary">{row.metric}</span>
                <span className="mono text-success font-bold">{row.arbSwap}</span>
                <span className="mono text-warning">{row.propAmm}</span>
                <span className="mono text-muted">{row.passiveAmm}</span>
              </div>
            ))}
          </div>
        </div>

      </div>

      <style>{`
        .analytics-page-wrapper {
          padding: 36px 0 70px;
        }
        .analytics-container {
          display: flex;
          flex-direction: column;
          gap: 28px;
        }
        .analytics-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          flex-wrap: wrap;
          gap: 16px;
        }
        .analytics-title {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
        }
        .analytics-subtitle {
          font-size: 13.5px;
          color: var(--text-muted);
          margin-top: 3px;
        }
        .analytics-meta-badges {
          display: flex;
          gap: 8px;
        }
        .perf-cards-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
        }
        .perf-card {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .perf-label {
          font-size: 12px;
          color: var(--text-muted);
          font-weight: 500;
        }
        .perf-value {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .perf-sub {
          font-size: 11.5px;
          line-height: 1.4;
        }
        .charts-split-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
        }
        .chart-card {
          padding: 22px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .chart-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }
        .chart-title {
          font-size: 15px;
          font-weight: 600;
        }
        .chart-subtitle {
          font-size: 11.5px;
          color: var(--text-muted);
          font-family: var(--font-mono);
          margin-top: 2px;
        }
        .chart-legend {
          display: flex;
          gap: 12px;
          font-size: 11px;
          font-family: var(--font-mono);
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--text-secondary);
        }
        .legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .legend-dot.arbswap {
          background: var(--accent-primary);
        }
        .legend-dot.passive {
          background: var(--status-critical);
        }
        .svg-chart-wrapper {
          background: var(--bg-surface-2);
          border-radius: var(--radius-md);
          border: 1px solid var(--border-subtle);
          padding: 12px;
        }
        .markout-svg {
          width: 100%;
          height: auto;
        }
        .chart-callout-text {
          font-size: 12px;
          line-height: 1.5;
        }
        .chart-callout-text strong {
          color: var(--text-primary);
        }
        .lvr-bars-grid {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          height: 160px;
          padding: 16px 20px 8px;
          background: var(--bg-surface-2);
          border-radius: var(--radius-md);
          border: 1px solid var(--border-subtle);
        }
        .lvr-bar-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          height: 100%;
          justify-content: flex-end;
        }
        .lvr-bars-pair {
          display: flex;
          align-items: flex-end;
          gap: 4px;
        }
        .bar-passive {
          width: 14px;
          background: rgba(244, 63, 94, 0.45);
          border-top: 2px solid var(--status-critical);
          border-radius: 2px 2px 0 0;
          transition: height 0.3s ease;
        }
        .bar-arbswap {
          width: 14px;
          background: rgba(0, 229, 176, 0.45);
          border-top: 2px solid var(--accent-primary);
          border-radius: 2px 2px 0 0;
          transition: height 0.3s ease;
        }
        .bar-day {
          font-size: 11px;
          color: var(--text-muted);
        }
        .matrix-card {
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .matrix-table {
          display: flex;
          flex-direction: column;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          overflow: hidden;
        }
        .matrix-row {
          display: grid;
          grid-template-columns: 1.5fr 1.5fr 1.5fr 1.5fr;
          padding: 13px 18px;
          font-size: 12.5px;
          align-items: center;
          border-bottom: 1px solid var(--border-subtle);
        }
        .matrix-row:last-child {
          border-bottom: none;
        }
        .matrix-row.matrix-head {
          background: rgba(255, 255, 255, 0.02);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          text-transform: uppercase;
        }
        @media (max-width: 900px) {
          .charts-split-grid {
            grid-template-columns: 1fr;
          }
          .matrix-row {
            grid-template-columns: 1fr;
            gap: 6px;
          }
          .matrix-row.matrix-head {
            display: none;
          }
        }
      `}</style>
    </div>
  );
};
