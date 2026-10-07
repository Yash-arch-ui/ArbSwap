import React from 'react';
import { motion } from 'motion/react';
import type { NavTab } from '../components/Navbar';
import { useProtocol } from '../context/ProtocolContext';

interface OverviewPageProps {
  onNavigate: (tab: NavTab) => void;
}

export const problemCards = [
  {
    index: '01 / ADVERSE SELECTION',
    metric: 'PASSIVE AMMS',
    title: 'Loss-Versus-Rebalancing',
    equation: 'LVR / V ≈ σ² / 8',
    tone: 'var(--uni-critical)',
    lead: 'A passive AMM only moves its price after an arbitrageur trades against it. When SOL jumps on external markets, fast traders pick off stale liquidity. LPs pay this cost continuously.',
    footer: 'Markout: -0.23 bps · Persistent toxic flow',
  },
  {
    index: '02 / CLOSED OPERATORS',
    metric: 'PROPRIETARY AMMS',
    title: 'Quote Degradation',
    equation: 'Gap = 1.08 bps · Fill = 39%',
    tone: 'var(--uni-warning)',
    lead: 'Closed propAMMs reprice without trades, but execute on private off-chain servers. Traders face intra-slot degradation, fee flips, and phantom liquidity.',
    footer: 'Traders face spoofing; capital is closed',
  },
  {
    index: '03 / ARBSWAP HYBRID',
    metric: 'ACTIVE + OPEN',
    title: 'Honest Active Liquidity',
    equation: 'V_active ≤ 8(R − gas) / σ²',
    tone: 'var(--uni-accent1)',
    lead: 'ArbSwap opens active quoting to permissionless deposits. Dynamic spreads track volatility while on-chain versioning guarantees the quoted price is the price you get.',
    footer: 'Markout: +0.38 bps · 0.00 bps execution gap',
  },
];

export const mechanicsPanels = [
  {
    index: '01 / ANCHOR LADDER',
    metric: '6-LEVEL ORDER BOOK',
    title: 'Constant-Product Segments',
    equation: 'P_res = P · (1 − g · q)',
    tone: 'var(--uni-accent1)',
    lead: 'Quotes are anchored to Pyth with inventory aversion. Six levels expand outward with smooth price impact. One cheap write updates the entire book for ~620 compute units.',
  },
  {
    index: '02 / RISK BUDGET',
    metric: 'LVR DEPTH THROTTLE',
    title: 'Volatility-Scaled Capacity',
    equation: 'L ≤ 4(R − gas) / (σ² √P)',
    tone: 'var(--uni-success)',
    lead: 'Derived directly from the LVR theorem: doubling volatility cuts active liquidity depth to a quarter. The vault contracts risk in turbulent regimes, preserving LP capital.',
  },
  {
    index: '03 / GUARDS',
    metric: 'CRYPTOGRAPHIC HONESTY',
    title: 'Versioned Execution',
    equation: 'require out ≥ min_out & v ≥ v_min',
    tone: 'var(--uni-accent1)',
    lead: 'Swaps carry explicit quote versions and min_out bounds. If market conditions move or quotes expire (>4.0s), the program reverts rather than filling at worse prices.',
  },
];

export const principles = [
  {
    number: '01 · Active repricing',
    title: 'Reprice without a trade.',
    line: 'A keeper writes small parameters on-chain for ~620 CU versus 16,938+ for a swap, keeping prices fresh before arbitrageurs strike.',
    badge: '620 CU WRITE',
  },
  {
    number: '02 · Dynamic spread',
    title: 'Spread widens with uncertainty.',
    line: 'Half-spreads scale with short-term volatility, inventory imbalance, and oracle confidence intervals, defending the book.',
    badge: 'EWMA VOL ESTIMATOR',
  },
  {
    number: '03 · Pro-rata shares',
    title: 'Oracle-free accounting.',
    line: 'Deposits and withdrawals are proportional in both tokens (v2-style), eliminating first-depositor and oracle-arbitrage manipulation surfaces.',
    badge: 'DECISION D-05',
  },
  {
    number: '04 · Epoch queues',
    title: 'Block phantom liquidity.',
    line: '150-slot deposit warm-up and epoch withdrawal queues prevent just-in-time liquidity and frontrunning volatility jumps.',
    badge: '150-SLOT WARMUP',
  },
  {
    number: '05 · Bounded keepers',
    title: 'Rule-bound execution.',
    line: 'The on-chain program validates bounds, staleness, and step caps. The keeper provides timeliness, but cannot set prices outside config.',
    badge: 'BONDED KEEPER',
  },
  {
    number: '06 · Measured markouts',
    title: 'Empirical verification.',
    line: 'Pre-registered evaluation on 6 weeks of 1-second price paths confirms positive 2-second markouts (+0.38 bps) and 86% LVR reduction.',
    badge: 'P1 REPLAY PROVEN',
  },
];

const inView = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "0px 0px 12% 0px" },
  transition: { duration: 0.35 },
};

export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { quoteState, vaultState } = useProtocol();

  return (
    <div className="overview-container">
      
      {/* 1. HERO SECTION */}
      <section className="hero" id="top">
        <div className="hero-content">
          <p className="eyebrow">
            <b /> ACTIVE LIQUIDITY AMM <span>·</span> OPEN POOLED CAPITAL
          </p>

          <h1 className="hero-title">
            One open vault for active liquidity.
          </h1>

          <p className="hero-lead">
            Traditional AMMs lose to latency arbitrage. Proprietary AMMs capture edge but remain closed and unaccountable. ArbSwap unites permissionless pooled capital with active, volatility-aware quoting on Solana.
          </p>

          <p className="hero-live">
            Live on Solana Devnet: SOL/USDC Vault v{quoteState.version} · Slot {quoteState.currentSlot} · Verified Pyth Feed
          </p>

          <div className="hero-actions">
            <button 
              type="button" 
              className="button button-solid" 
              onClick={() => onNavigate('swap')}
            >
              Launch Swap
            </button>
            <button 
              type="button" 
              className="underlink" 
              onClick={() => onNavigate('vault')}
            >
              Explore Vault →
            </button>
          </div>
        </div>
      </section>


      {/* 2. LIVE METRICS RIBBON */}
      <section className="metrics-ribbon">
        <div className="metrics-ribbon-grid">
          <div className="ribbon-card">
            <span className="ribbon-label">Vault TVL</span>
            <p className="ribbon-val mono">${vaultState.tvlUsd.toLocaleString()}</p>
            <span className="ribbon-sub mono">{vaultState.baseReserve.toLocaleString()} SOL + ${vaultState.quoteReserve.toLocaleString()} USDC</span>
          </div>
          <div className="ribbon-card">
            <span className="ribbon-label">2-Second Markout</span>
            <p className="ribbon-val mono text-accent">+0.38 bps</p>
            <span className="ribbon-sub">Passive AMMs average -0.23 bps</span>
          </div>
          <div className="ribbon-card">
            <span className="ribbon-label">Quote-vs-Fill Gap</span>
            <p className="ribbon-val mono text-success">0.00 bps</p>
            <span className="ribbon-sub">Honest execution guarantee</span>
          </div>
          <div className="ribbon-card">
            <span className="ribbon-label">Update Compute</span>
            <p className="ribbon-val mono">~620 CU</p>
            <span className="ribbon-sub mono">16,938+ CU for passive swaps</span>
          </div>
        </div>
      </section>

      {/* 3. MANIFESTO STATEMENT */}
      <section className="manifesto-section">
        <p className="section-index">/ 01 · The Thesis</p>
        <p className="manifesto-statement">
          "A passive AMM only changes price after someone trades against it. When SOL moves on Binance, fast arbitrageurs buy cheap tokens from the pool and sell elsewhere. The people who deposited funds pay for this. <em>ArbSwap moves the quote first.</em>"
        </p>
      </section>

      {/* 4. THE PROBLEM COMPARISON */}
      <section className="problem-section" id="problem">
        <div className="problem-heading">
          <p className="section-index">/ 02 · The Problem</p>
          <h2>
            Passive pools bleed LVR. <em>propAMMs exploit execution.</em>
          </h2>
          <p>
            Decentralized market making has been trapped between passive capital that loses to external arbitrage and closed propAMMs that spoof quotes. ArbSwap resolves the trade-off.
          </p>
        </div>

        <div className="problem-grid">
          {problemCards.map((card, i) => (
            <motion.article className="problem-card" key={i} {...inView}>
              <div className="card-rule">
                <span>{card.index}</span>
                <b style={{ color: card.tone }}>{card.metric}</b>
              </div>
              <h3>{card.title}</h3>
              <div className="equation mono" style={{ color: card.tone }}>
                {card.equation}
              </div>
              <p className="problem-lead">{card.lead}</p>
              <span className="card-footer-note mono">{card.footer}</span>
            </motion.article>
          ))}
        </div>
      </section>

      {/* 5. MECHANICS SECTION */}
      <section className="geometry-section" id="mechanics">
        <div className="geometry-heading">
          <p className="section-index">/ 03 · Mechanics & Core Math</p>
          <div className="geometry-statement">
            <h2>
              The pricing engine is built from three established models. <em>An anchor ladder, an LVR throttle, and cryptographic guards.</em>
            </h2>
          </div>
        </div>

        <div className="geometry-grid">
          {mechanicsPanels.map((panel, i) => (
            <motion.article className="geometry-panel" key={i} {...inView}>
              <div className="card-rule">
                <span>{panel.index}</span>
                <b style={{ color: panel.tone }}>{panel.metric}</b>
              </div>
              <h3>{panel.title}</h3>
              <div className="equation mono" style={{ color: panel.tone }}>
                {panel.equation}
              </div>
              <p>{panel.lead}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* 6. SIX PROTOCOL PRINCIPLES */}
      <section className="protocol-section" id="protocol">
        <div className="problem-heading">
          <p className="section-index">/ 04 · The Protocol</p>
          <h2>
            Active liquidity, <em>made explicit.</em>
          </h2>
          <p>
            Six on-chain rules define ArbSwap's market-making model. Every parameter is public, deterministic, and verifiable.
          </p>
        </div>

        <div className="principle-grid">
          {principles.map((pr, i) => (
            <motion.article className="principle-card" key={i} {...inView}>
              <div className="principle-visual-box">
                <span className="badge badge-neutral mono">{pr.badge}</span>
              </div>
              <p className="card-number">{pr.number}</p>
              <h3>{pr.title}</h3>
              <p>{pr.line}</p>
            </motion.article>
          ))}
        </div>
      </section>

      {/* 7. FOUR APPLICATION MODULES */}
      <section className="modules-section">
        <div className="problem-heading">
          <p className="section-index">/ 05 · Application Modules</p>
          <h2>
            Everything connects to the <em>production spec.</em>
          </h2>
          <p>Four specialized interfaces built for traders, liquidity providers, and risk monitors.</p>
        </div>

        <div className="modules-grid">
          <div className="module-box" onClick={() => onNavigate('swap')}>
            <span className="mono module-tag">MODULE 01</span>
            <h3>Trader / Swap</h3>
            <p>SOL/USDC active ladder execution with live 6-level depth visualizer, dynamic spreads, and strict min_out guarantees.</p>
            <span className="module-link">Open Terminal →</span>
          </div>

          <div className="module-box" onClick={() => onNavigate('vault')}>
            <span className="mono module-tag">MODULE 02</span>
            <h3>LP / Vault</h3>
            <p>Pro-rata two-token deposits without oracle manipulation, 150-slot warm-up protection, and epoch withdrawal queues.</p>
            <span className="module-link">Access Vault →</span>
          </div>

          <div className="module-box" onClick={() => onNavigate('risk')}>
            <span className="mono module-tag">MODULE 03</span>
            <h3>Risk Engine</h3>
            <p>Live Pyth confidence and staleness tracking, EWMA volatility estimators, parameter bound verification, and trip simulation.</p>
            <span className="module-link">View Risk Dashboard →</span>
          </div>

          <div className="module-box" onClick={() => onNavigate('analytics')}>
            <span className="mono module-tag">MODULE 04</span>
            <h3>Analytics</h3>
            <p>Post-fill markout curves (-5s to +15s), daily LVR avoided comparisons, and the empirical proof matrix from the P1 held-out replay.</p>
            <span className="module-link">Inspect Metrics →</span>
          </div>
        </div>
      </section>

      {/* 8. GATEWAY & FOOTER CTA */}
      <section className="gateway-section">
        <span className="gateway-bg-text" aria-hidden="true">ARBSWAP</span>
        <div className="gateway-content">
          <p className="section-index">/ 06 · Gateway</p>
          <h2>
            Active liquidity <em>is now open.</em>
          </h2>
          <p>Trade against honest volatility-aware quotes or deposit capital into the Solana market-making vault.</p>
          <div className="hero-actions">
            <button type="button" className="button button-solid" onClick={() => onNavigate('swap')}>
              Trade SOL/USDC
            </button>
            <button type="button" className="underlink" onClick={() => onNavigate('vault')}>
              Deposit in Vault
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="site-footer">
        <div>
          <strong>ArbSwap</strong> · Active Liquidity Protocol on Solana
        </div>
        <div className="mono">
          Solana Devnet · Verified Pyth Oracle
        </div>
      </footer>

      <style>{`
        .overview-container {
          display: flex;
          flex-direction: column;
          gap: 120px;
          padding-bottom: 60px;
        }

        /* Hero */
        .hero {
          position: relative;
          display: grid;
          min-height: 85svh;
          place-items: center;
          text-align: center;
          padding: 80px 20px 40px;
          overflow: hidden;
        }
        .hero-content {
          position: relative;
          z-index: 2;
          max-width: 960px;
          margin: 0 auto;
        }
        .hero-title {
          font-size: clamp(3.2rem, 7vw, 6.4rem);
          font-weight: 500;
          letter-spacing: -0.04em;
          line-height: 0.95;
          margin: 0 auto 24px;
          max-width: 14ch;
        }
        .hero-lead {
          max-width: 62ch;
          margin: 0 auto 28px;
          color: var(--uni-neutral2);
          font-size: clamp(16px, 1.6vw, 19px);
          line-height: 1.65;
        }
        .hero-live {
          color: var(--uni-neutral3);
          font: 12px var(--uni-mono);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-bottom: 34px;
        }
        .hero-actions {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }

        /* Primary CTA — solid filled */
        .button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 14px 28px;
          border-radius: 100px;
          font-size: 15px;
          font-weight: 600;
          transition: background 0.15s, transform 0.12s, box-shadow 0.15s;
          cursor: pointer;
          border: none;
        }
        .button-solid {
          background: var(--uni-accent1);
          color: var(--uni-on-accent);
          box-shadow: 0 0 24px rgba(0, 229, 176, 0.25);
        }
        .button-solid:hover {
          background: var(--uni-accent1-hover);
          box-shadow: 0 0 32px rgba(0, 229, 176, 0.4);
          transform: translateY(-1px);
        }
        .button-solid:active {
          transform: translateY(0);
        }

        /* Ghost / text-link secondary CTA */
        .underlink {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 14px 20px;
          border-radius: 100px;
          font-size: 15px;
          font-weight: 500;
          color: var(--uni-neutral2);
          border: 1px solid var(--uni-surface3);
          background: transparent;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
          cursor: pointer;
        }
        .underlink:hover {
          color: var(--uni-neutral1);
          border-color: rgba(255, 255, 255, 0.25);
          background: var(--uni-surface2);
        }

        /* Metrics Ribbon */
        .metrics-ribbon {
          width: 100%;
        }
        .metrics-ribbon-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }
        .ribbon-card {
          padding: 24px;
          border: 1px solid var(--uni-surface3);
          border-radius: 20px;
          background: var(--uni-surface1);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .ribbon-label {
          font-size: 11px;
          font-family: var(--uni-mono);
          text-transform: uppercase;
          color: var(--uni-neutral2);
          letter-spacing: 0.1em;
        }
        .ribbon-val {
          font-size: 28px;
          font-weight: 600;
        }
        .ribbon-sub {
          font-size: 12px;
          color: var(--uni-neutral2);
        }

        /* Manifesto */
        .manifesto-section {
          padding: 60px 0;
          border-top: 1px solid var(--uni-surface3);
          border-bottom: 1px solid var(--uni-surface3);
        }
        .manifesto-statement {
          max-width: 48ch;
          font-size: clamp(24px, 3.2vw, 38px);
          font-weight: 400;
          line-height: 1.25;
          letter-spacing: -0.025em;
          color: var(--uni-neutral1);
        }
        .manifesto-statement em {
          color: var(--uni-accent1);
          font-style: normal;
        }

        /* Problem Section */
        .problem-section, .geometry-section, .protocol-section, .modules-section {
          padding: 40px 0 0;
        }
        .problem-heading {
          max-width: 840px;
          margin-bottom: 48px;
        }
        .problem-heading h2 {
          font-size: clamp(32px, 5vw, 56px);
          font-weight: 500;
          letter-spacing: -0.03em;
          line-height: 1.05;
          margin-bottom: 16px;
        }
        .problem-heading h2 em {
          color: var(--uni-neutral2);
          font-style: normal;
        }
        .problem-heading p {
          color: var(--uni-neutral2);
          font-size: 16px;
          line-height: 1.6;
          max-width: 58ch;
        }
        .problem-grid, .geometry-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .problem-card, .geometry-panel {
          display: flex;
          flex-direction: column;
          min-height: 480px;
          padding: 32px;
          border: 1px solid var(--uni-surface3);
          border-radius: 20px;
          background: var(--uni-surface1);
          transition: border-color 0.2s, background 0.2s;
        }
        .problem-card:hover, .geometry-panel:hover {
          border-color: rgba(255, 255, 255, 0.2);
          background: var(--uni-surface1-hover);
        }
        .problem-card h3, .geometry-panel h3 {
          font-size: clamp(24px, 2.5vw, 32px);
          font-weight: 500;
          letter-spacing: -0.025em;
          margin-bottom: 24px;
        }
        .card-footer-note {
          margin-top: auto;
          padding-top: 20px;
          border-top: 1px dashed var(--uni-surface3);
          font-size: 12px;
          color: var(--uni-neutral2);
        }

        /* Geometry mechanics */
        .geometry-statement h2 {
          font-size: clamp(26px, 3.8vw, 46px);
          font-weight: 500;
          letter-spacing: -0.025em;
          line-height: 1.15;
          margin: 16px 0 48px;
        }

        /* Protocol 6-card grid */
        .principle-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .principle-card {
          display: flex;
          flex-direction: column;
          padding: 28px;
          border: 1px solid var(--uni-surface3);
          border-radius: 20px;
          background: var(--uni-surface1);
          min-height: 300px;
        }
        .principle-visual-box {
          height: 44px;
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .card-number {
          font: 11px var(--uni-mono);
          color: var(--uni-neutral3);
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: 8px;
        }
        .principle-card h3 {
          font-size: 20px;
          font-weight: 500;
          margin-bottom: 10px;
        }
        .principle-card p:last-child {
          font-size: 14px;
          line-height: 1.6;
          color: var(--uni-neutral2);
        }

        /* Modules */
        .modules-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
        }
        .module-box {
          padding: 28px;
          border: 1px solid var(--uni-surface3);
          border-radius: 20px;
          background: var(--uni-surface1);
          cursor: pointer;
          display: flex;
          flex-direction: column;
          transition: all 0.2s ease;
        }
        .module-box:hover {
          border-color: var(--uni-accent1);
          transform: translateY(-2px);
          background: var(--uni-surface1-hover);
        }
        .module-tag {
          font-size: 11px;
          color: var(--uni-accent1);
          margin-bottom: 8px;
        }
        .module-box h3 {
          font-size: 20px;
          font-weight: 500;
          margin-bottom: 8px;
        }
        .module-box p {
          font-size: 13.5px;
          line-height: 1.6;
          color: var(--uni-neutral2);
          margin-bottom: 20px;
        }
        .module-link {
          margin-top: auto;
          font-size: 13px;
          font-weight: 600;
          color: var(--uni-accent1);
        }

        /* Gateway section */
        .gateway-section {
          position: relative;
          display: grid;
          min-height: 60svh;
          place-items: center;
          text-align: center;
          overflow: hidden;
          padding: 80px 20px;
          border-top: 1px solid var(--uni-surface3);
        }
        .gateway-bg-text {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: clamp(6rem, 18vw, 20rem);
          font-weight: 700;
          color: transparent;
          -webkit-text-stroke: 1px rgba(255, 255, 255, 0.04);
          pointer-events: none;
          letter-spacing: -0.05em;
        }
        .gateway-content {
          position: relative;
          z-index: 2;
          max-width: 640px;
        }
        .gateway-content h2 {
          font-size: clamp(34px, 5vw, 56px);
          font-weight: 500;
          letter-spacing: -0.03em;
          margin: 12px 0 16px;
        }
        .gateway-content h2 em {
          color: var(--uni-neutral2);
          font-style: normal;
        }
        .gateway-content p {
          color: var(--uni-neutral2);
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 32px;
        }

        /* Footer */
        .site-footer {
          border-top: 1px solid var(--uni-surface3);
          padding-top: 28px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: var(--uni-neutral2);
          font-size: 13px;
        }

        @media (max-width: 900px) {
          .problem-grid, .geometry-grid, .principle-grid {
            grid-template-columns: 1fr;
          }
          .problem-card, .geometry-panel {
            min-height: auto;
          }
          .site-footer {
            flex-direction: column;
            gap: 12px;
            text-align: center;
          }
        }
      `}</style>
    </div>
  );
};
