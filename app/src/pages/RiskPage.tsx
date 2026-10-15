import React from 'react';
import { 
  Activity, 
  Sliders, 
  Radio, 
  CheckCircle2, 
  AlertOctagon, 
  Cpu
} from 'lucide-react';
import { useProtocol } from '../context/ProtocolContext';
import { KeeperRewards } from '../components/KeeperRewards';
import { ACTIVE_VAULT } from '../chain/config';
import { ReadOnlyBanner } from '../components/ReadOnlyMode';

export const RiskPage: React.FC = () => {
  const { quoteState, riskBreakers, status, protocolParams } = useProtocol();

  const isTripped = riskBreakers.circuitBreakerTripped;
  const hasQuote = quoteState.hasQuote;
  const oracleOnline = hasQuote && quoteState.status !== 'Expired';

  return (
    <div className="risk-page-wrapper">
      <div className="container risk-container">
        
        {/* Header Block */}
        <div className="risk-header-block">
          <div>
            <h1 className="risk-title">Risk Engine & Circuit Breakers</h1>
            <p className="risk-subtitle">
              On-chain guardrails, bounded keeper limits, and automated circuit breakers protecting LP capital
            </p>
          </div>
          <div className="risk-header-actions">
            <span className="badge badge-neutral mono">
              Read-only — breaker actions are admin-only on-chain
            </span>
          </div>
        </div>

        <KeeperRewards />

        <ReadOnlyBanner detail="Risk, oracle and keeper data are read live; breaker actions, parameter updates and reward claims cannot be submitted from this build." />

        {/* Global Health Status Banner */}
        <div className={`glass-card status-banner ${isTripped ? 'tripped' : 'healthy'}`}>
          <div className="status-banner-left">
            <div className="status-icon-wrap">
              {isTripped ? (
                <AlertOctagon size={24} color="var(--status-critical)" />
              ) : (
                <CheckCircle2 size={24} color="var(--status-success)" />
              )}
            </div>
            <div>
              <h2 className="status-heading">
                {isTripped ? 'Circuit Breakers Tripped — Quotes Paused' : 'All Risk Guards Nominal & Active'}
              </h2>
              <p className="status-desc">
                {isTripped 
                  ? `Reason: ${riskBreakers.activeBreakerReason}. All quote executions are frozen on-chain; LP withdrawals remain open.`
                  : status.quote.reason}
              </p>
            </div>
          </div>
          <div className="status-banner-right">
            <span className={`badge ${isTripped ? 'badge-critical' : 'badge-fresh'}`}>
              Vault: {isTripped ? 'PAUSED' : 'ACTIVE'}
            </span>
            <span className="badge badge-neutral mono">
              Keeper: {riskBreakers.keeperBondActive ? 'BONDED' : 'PERMISSIONLESS'}
            </span>
          </div>
        </div>

        {/* 4 Core Risk Pillars Grid */}
        <div className="risk-pillars-grid">
          
          {/* Pillar 1: Oracle Health (Pyth) */}
          <div className="glass-card pillar-card">
            <div className="pillar-header">
              <div className="pillar-title-wrap">
                <Radio size={16} color="var(--status-info)" />
                <h3>Pyth Oracle Integrity</h3>
              </div>
              <span className={`badge ${oracleOnline ? 'badge-fresh' : 'badge-neutral'}`}>
                {oracleOnline ? 'Fresh quote' : hasQuote ? 'Quote expired' : 'No quote'}
              </span>
            </div>

            <div className="pillar-metrics">
              <div className="pillar-row">
                <span>Current Staleness</span>
                <span className="mono font-bold text-success">{riskBreakers.oracleCurrentStalenessSec}s</span>
              </div>
              <div className="pillar-progress-track">
                <div 
                  className="pillar-progress-fill" 
                  style={{ width: `${(riskBreakers.oracleCurrentStalenessSec / riskBreakers.oracleStalenessMaxSec) * 100}%` }}
                ></div>
              </div>
              <div className="pillar-sub-row">
                <span className="text-muted">Hard Trip Threshold: &gt; {riskBreakers.oracleStalenessMaxSec}s</span>
                <span className="mono text-muted">Max Staleness Cap</span>
              </div>

              <div className="pillar-row mt-3">
                <span>Confidence Ratio (c / P)</span>
                <span className="mono font-bold">{quoteState.oracleConfBps} bps</span>
              </div>
              <div className="pillar-progress-track">
                <div 
                  className="pillar-progress-fill warning" 
                  style={{ width: `${(quoteState.oracleConfBps / riskBreakers.maxConfRatioBps) * 100}%` }}
                ></div>
              </div>
              <div className="pillar-sub-row">
                <span className="text-muted">Hard Trip Threshold: &gt; {riskBreakers.maxConfRatioBps} bps</span>
                <span className="mono text-muted">{riskBreakers.maxConfRatioBps ? `${(riskBreakers.maxConfRatioBps / 100).toFixed(2)}% bound (Config)` : 'Unavailable'}</span>
              </div>
            </div>

            <div className="pillar-footer">
              <span className="mono text-muted">Feed: {ACTIVE_VAULT.pythFeedId.slice(0, 8)}… · verified on-chain by the deployed program</span>
            </div>
          </div>

          {/* Pillar 2: Volatility Estimator & Jump Detector */}
          <div className="glass-card pillar-card">
            <div className="pillar-header">
              <div className="pillar-title-wrap">
                <Activity size={16} color="var(--accent-primary)" />
                <h3>EWMA Volatility & Jump Detector</h3>
              </div>
              <span className="badge badge-neutral mono">Keeper-local (not indexed)</span>
            </div>

            <div className="pillar-metrics">
              <div className="pillar-row">
                <span>Short-Window Vol (σ_s, λ=0.94)</span>
                <span className="mono text-muted">Unavailable (keeper-local)</span>
              </div>
              <div className="pillar-row mt-2">
                <span>Medium-Window Vol (σ_m, λ=0.99)</span>
                <span className="mono text-muted">Unavailable (keeper-local)</span>
              </div>
              <div className="pillar-row mt-2">
                <span>Recent Price Move (1-sec window)</span>
                <span className="mono text-muted">Unavailable (keeper-local)</span>
              </div>

              <div className="jump-detector-box">
                <span className="jump-label">Jump Flag Status</span>
                <span className="jump-status mono text-muted">Not observable on-chain (keeper-local)</span>
                <p className="jump-note text-muted">
                  Triggers 4x σ cool-down widenings if |r_t| exceeds 4·σ_s. The flag is computed
                  off-chain by the keeper and is not written to any account.
                </p>
              </div>
            </div>

            <div className="pillar-footer">
              <span className="mono text-muted">Model: Avellaneda-Baggiani Hybrid Estimator</span>
            </div>
          </div>

          {/* Pillar 3: On-Chain Parameter Bounds (Program Enforced) */}
          <div className="glass-card pillar-card">
            <div className="pillar-header">
              <div className="pillar-title-wrap">
                <Sliders size={16} color="var(--accent-indigo)" />
                <h3>On-Chain Parameter Bounds</h3>
              </div>
              <span className="badge badge-fresh">Enforced</span>
            </div>

            <div className="pillar-metrics">
              <div className="bound-row">
                <div>
                  <span className="bound-name">Max Anchor Step</span>
                  <span className="bound-val mono text-muted">Limit: {riskBreakers.maxAnchorStepBps} bps / update (Config)</span>
                </div>
                <span className="badge badge-fresh">Enforced</span>
              </div>
              <div className="bound-row">
                <div>
                  <span className="bound-name">Spread Clamping</span>
                  <span className="bound-val mono text-muted">
                    {riskBreakers.minSpreadBps || riskBreakers.maxSpreadBps
                      ? `Min: ${riskBreakers.minSpreadBps} bps · Max: ${riskBreakers.maxSpreadBps} bps (Config)`
                      : 'Unavailable'}
                  </span>
                </div>
                <span className="badge badge-fresh">Enforced</span>
              </div>
              <div className="bound-row">
                <div>
                  <span className="bound-name">Inventory Imbalance Cap</span>
                  <span className="bound-val mono text-muted">
                    {riskBreakers.maxInventorySkewBps
                      ? `Limit: |q| < ${(riskBreakers.maxInventorySkewBps / 10000).toFixed(2)} (Config)`
                      : 'Unavailable'}
                  </span>
                </div>
                <span className="badge badge-fresh">Enforced</span>
              </div>
              <div className="bound-row">
                <div>
                  <span className="bound-name">Quote Expiry Window</span>
                  <span className="bound-val mono text-muted">
                    {protocolParams
                      ? `Grace: ${protocolParams.graceSlots} slots · Expiry: ${protocolParams.expirySlots} slots (Config)`
                      : 'Unavailable'}
                  </span>
                </div>
                <span className="badge badge-fresh">Enforced</span>
              </div>
            </div>

            <div className="pillar-footer">
              <span className="mono text-muted">Admin: Timelocked 24h · No Fund Seizure Path</span>
            </div>
          </div>

          {/* Pillar 4: Bonded Keeper Health */}
          <div className="glass-card pillar-card">
            <div className="pillar-header">
              <div className="pillar-title-wrap">
                <Cpu size={16} color="var(--status-warning)" />
                <h3>Keeper Eligibility</h3>
              </div>
              <span className="badge badge-fresh">
                {riskBreakers.keeperBondActive ? 'Bonded' : 'Permissionless'}
              </span>
            </div>

            <div className="pillar-metrics">
              <div className="pillar-row">
                <span>Configured keeper (not the quote author)</span>
                <span className="mono text-muted">{riskBreakers.keeperActiveAddress}</span>
              </div>
              <div className="pillar-row mt-2">
                <span>Valid Quote Updates (24h)</span>
                <span className="mono text-muted" />
              </div>
              <div className="pillar-row mt-2">
                <span>Rejected / Stale Updates</span>
                <span className="mono text-muted" />
              </div>
              <div className="pillar-row mt-2">
                <span>Mean Compute Units / Update</span>
                <span className="mono text-muted" />
              </div>
              <div className="pillar-row mt-2">
                <span>Adaptive Priority Fee</span>
                <span className="mono text-muted" />
              </div>
            </div>

            <div className="pillar-footer">
              <span className="mono text-muted">Slashing Condition: Anchor dev &gt; Pyth dev</span>
            </div>
          </div>

        </div>

        {/* Detailed Threat Model & Mitigation Reference Table */}
        <div className="glass-card threat-table-card">
          <div className="card-header-row">
            <h3>Solana-Specific Threat Matrix & On-Chain Mitigations</h3>
            <span className="mono text-muted">Audited Anchor Architecture (docs/THREAT_MODEL.md)</span>
          </div>

          <div className="threat-table">
            <div className="threat-row head">
              <span>Attack Vector</span>
              <span>Potential Exploitation</span>
              <span>ArbSwap On-Chain Mitigation</span>
              <span>Status</span>
            </div>
            <div className="threat-row">
              <span className="font-bold">Stale Oracle Print</span>
              <span className="text-muted">CEX price moves, oracle lags, LPs picked off</span>
              <span>Staleness penalty kappa·(age - grace) + 10-slot hard expiry + LVR depth throttle</span>
              <span className="badge badge-fresh">Protected</span>
            </div>
            <div className="threat-row">
              <span className="font-bold">Flashblock / Intra-Slot Spoofing</span>
              <span className="text-muted">Quote displayed then degraded at settlement</span>
              <span>Versioned quotes on swap instruction + strict min_out check + public fee formulas</span>
              <span className="badge badge-fresh">Protected</span>
            </div>
            <div className="threat-row">
              <span className="font-bold">Phantom Liquidity</span>
              <span className="text-muted">Deposit before block, withdraw after block</span>
              <span>150-slot deposit warm-up + epoch queue for pro-rata withdrawals</span>
              <span className="badge badge-fresh">Protected</span>
            </div>
            <div className="threat-row">
              <span className="font-bold">First Depositor / Share Inflation</span>
              <span className="text-muted">Donation attack skews share value</span>
              <span>Permanent 1,000 MIN_LIQUIDITY burn on pool initialization (v2-style)</span>
              <span className="badge badge-fresh">Protected</span>
            </div>
            <div className="threat-row">
              <span className="font-bold">Keeper Key Compromise</span>
              <span className="text-muted">Malicious bot tries to print off-market bids</span>
              <span>On-chain max anchor step (50 bps) + Pyth deviation bound + bound slashing</span>
              <span className="badge badge-fresh">Protected</span>
            </div>
          </div>
        </div>

      </div>

      <style>{`
        .risk-page-wrapper {
          padding: 36px 20px 80px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .risk-container {
          display: flex;
          flex-direction: column;
          gap: 28px;
        }
        .risk-header-block {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          flex-wrap: wrap;
          gap: 16px;
        }
        .risk-title {
          font-size: 28px;
          font-weight: 700;
          letter-spacing: -0.025em;
          color: var(--text-primary);
        }
        .risk-subtitle {
          font-size: 14px;
          color: var(--text-muted);
          margin-top: 4px;
        }
        .status-banner {
          padding: 22px 26px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-radius: 18px;
          transition: all 0.25s ease;
        }
        .status-banner.healthy {
          border: 1px solid rgba(0, 229, 176, 0.35);
          background: linear-gradient(135deg, rgba(0, 229, 176, 0.08), var(--uni-surface1));
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 20px rgba(0, 229, 176, 0.08);
        }
        .status-banner.tripped {
          border: 1px solid rgba(244, 63, 94, 0.45);
          background: linear-gradient(135deg, rgba(244, 63, 94, 0.12), var(--uni-surface1));
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 20px rgba(244, 63, 94, 0.15);
        }
        .status-banner-left {
          display: flex;
          align-items: center;
          gap: 18px;
        }
        .status-icon-wrap {
          display: grid;
          place-items: center;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-default);
        }
        .status-heading {
          font-size: 17px;
          font-weight: 700;
          color: var(--text-primary);
        }
        .status-desc {
          font-size: 13px;
          color: var(--text-secondary);
          margin-top: 2px;
        }
        .status-banner-right {
          display: flex;
          gap: 8px;
        }
        .risk-pillars-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
        }
        .pillar-card {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .pillar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .pillar-title-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pillar-title-wrap h3 {
          font-size: 14.5px;
          font-weight: 600;
        }
        .pillar-metrics {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .pillar-row {
          display: flex;
          justify-content: space-between;
          font-size: 12.5px;
        }
        .pillar-sub-row {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
        }
        .pillar-progress-track {
          width: 100%;
          height: 6px;
          background: var(--bg-surface-3);
          border-radius: var(--radius-pill);
          overflow: hidden;
        }
        .pillar-progress-fill {
          height: 100%;
          background: var(--status-success);
          border-radius: var(--radius-pill);
          transition: width 0.3s ease;
        }
        .pillar-progress-fill.warning {
          background: var(--status-warning);
        }
        .jump-detector-box {
          background: var(--bg-surface-2);
          padding: 12px;
          border-radius: var(--radius-md);
          margin-top: 6px;
        }
        .jump-label {
          font-size: 11px;
          color: var(--text-muted);
          display: block;
        }
        .jump-status {
          font-size: 13px;
          font-weight: 700;
        }
        .jump-note {
          font-size: 11px;
          margin-top: 4px;
        }
        .bound-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .bound-row:last-child {
          border-bottom: none;
        }
        .bound-name {
          font-size: 12.5px;
          font-weight: 500;
          display: block;
        }
        .bound-val {
          font-size: 11px;
        }
        .pillar-footer {
          margin-top: auto;
          padding-top: 12px;
          border-top: 1px dashed var(--border-subtle);
          font-size: 11px;
        }
        .threat-table-card {
          padding: 22px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .threat-table {
          display: flex;
          flex-direction: column;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          overflow: hidden;
        }
        .threat-row {
          display: grid;
          grid-template-columns: 1.2fr 1.5fr 2fr 0.8fr;
          padding: 12px 16px;
          font-size: 12px;
          align-items: center;
          border-bottom: 1px solid var(--border-subtle);
        }
        .threat-row:last-child {
          border-bottom: none;
        }
        .threat-row.head {
          background: rgba(255, 255, 255, 0.02);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          text-transform: uppercase;
        }
        .reset-breaker-btn {
          background: var(--status-success);
          color: #051410;
        }
        @media (max-width: 800px) {
          .status-banner {
            flex-direction: column;
            align-items: flex-start;
            gap: 16px;
          }
          .threat-row {
            grid-template-columns: 1fr;
            gap: 6px;
          }
          .threat-row.head {
            display: none;
          }
        }
      `}</style>
    </div>
  );
};
