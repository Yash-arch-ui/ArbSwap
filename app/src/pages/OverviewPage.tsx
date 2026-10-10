import React, { useRef, useEffect } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'motion/react';
import type { NavTab } from '../components/Navbar';
import { useProtocol } from '../context/ProtocolContext';

interface OverviewPageProps {
  onNavigate: (tab: NavTab) => void;
}

export const revealRange = (index: number, total: number): [number, number] => {
  const start = (index / total) * 0.75;
  return [start, start + 0.15];
};

interface WordItem {
  text: string;
  isEm?: boolean;
}

function RevealedWord({
  word,
  index,
  total,
  progress,
}: {
  word: WordItem;
  index: number;
  total: number;
  progress: MotionValue<number>;
}) {
  const opacity = useTransform(progress, revealRange(index, total), [0.15, 1]);
  return (
    <motion.span
      style={{
        opacity,
        color: word.isEm ? 'var(--uni-accent1)' : undefined,
        fontStyle: word.isEm ? 'italic' : undefined,
      }}
    >
      {word.text}{' '}
    </motion.span>
  );
}

const manifestoWords: WordItem[] = [
  { text: "A" }, { text: "passive" }, { text: "AMM" }, { text: "only" }, { text: "changes" },
  { text: "price" }, { text: "after" }, { text: "someone" }, { text: "trades" }, { text: "against" },
  { text: "it." }, { text: "When" }, { text: "SOL" }, { text: "moves" }, { text: "on" },
  { text: "external" }, { text: "markets," }, { text: "fast" }, { text: "arbitrageurs" }, { text: "extract" },
  { text: "stale" }, { text: "liquidity." }, { text: "Passive" }, { text: "LPs" }, { text: "pay" },
  { text: "this" }, { text: "cost" }, { text: "continuously." },
  { text: "ArbSwap", isEm: true }, { text: "moves", isEm: true }, { text: "the", isEm: true },
  { text: "quote", isEm: true }, { text: "first.", isEm: true },
];

const mechanicsWords: WordItem[] = [
  { text: "The" }, { text: "pricing" }, { text: "engine" }, { text: "is" }, { text: "built" },
  { text: "from" }, { text: "three" }, { text: "mathematical" }, { text: "pillars." },
  { text: "An", isEm: true }, { text: "anchor", isEm: true }, { text: "ladder,", isEm: true },
  { text: "a", isEm: true }, { text: "volatility", isEm: true }, { text: "throttle,", isEm: true },
  { text: "and", isEm: true }, { text: "cryptographic", isEm: true }, { text: "guards.", isEm: true },
];

export const problemCards = [
  {
    index: '01 / ADVERSE SELECTION',
    metric: 'PASSIVE AMMS',
    title: 'Loss-Versus-Rebalancing',
    equation: 'LVR / V ≈ σ² / 8',
    tone: 'var(--uni-critical)',
    lead: 'Passive pools reprice only after arbitrageurs extract value from stale quotes. LPs continuously bleed to toxic order flow.',
    footer: 'Markout: -0.23 bps · Persistent toxic flow',
  },
  {
    index: '02 / CLOSED OPERATORS',
    metric: 'PROPRIETARY AMMS',
    title: 'Quote Degradation',
    equation: 'Gap = 1.08 bps · Fill = 39%',
    tone: 'var(--uni-warning)',
    lead: 'Closed propAMMs rely on off-chain servers, exposing traders to intra-slot degradation, fee flips, and phantom liquidity.',
    footer: 'Traders face spoofing; capital is closed',
  },
  {
    index: '03 / ARBSWAP HYBRID',
    metric: 'ACTIVE + OPEN',
    title: 'Honest Active Liquidity',
    equation: 'V_active ≤ 8(R − gas) / σ²',
    tone: 'var(--uni-accent1)',
    lead: 'Permissionless vaults with volatility-responsive pricing. On-chain versioning guarantees quoted prices match execution.',
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
    lead: 'Pyth-anchored 6-tier ladder with inventory aversion. Updates the complete book in a single ~620 CU transaction.',
  },
  {
    index: '02 / RISK BUDGET',
    metric: 'LVR DEPTH THROTTLE',
    title: 'Volatility-Scaled Capacity',
    equation: 'L ≤ 4(R − gas) / (σ² √P)',
    tone: 'var(--uni-success)',
    lead: 'Dynamic depth governed by the LVR theorem. Market volatility automatically contracts vault exposure to protect LP capital.',
  },
  {
    index: '03 / GUARDS',
    metric: 'CRYPTOGRAPHIC HONESTY',
    title: 'Versioned Execution',
    equation: 'require out ≥ min_out & v ≥ v_min',
    tone: 'var(--uni-accent1)',
    lead: 'Enforces explicit quote versions and slippage floors. Swaps instantly revert if prices shift or quotes age past 4.0s.',
  },
];

/* =========================================================================
   MATH.MD DERIVED GRAPH & PICTORIAL VISUALS FOR PROTOCOL PRINCIPLES
   ========================================================================= */

function VisualActiveRepricing() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <div className="bench-bars-wrap">
        <div className="bench-row">
          <div className="bench-meta">
            <span className="mono">ARBSWAP KEEPER</span>
            <b className="mono text-accent">~620 CU</b>
          </div>
          <div className="bench-track">
            <div className="bench-fill keeper-bar" style={{ width: '12%' }} />
          </div>
        </div>
        <div className="bench-row">
          <div className="bench-meta">
            <span className="mono">PASSIVE AMM SWAP</span>
            <b className="mono text-muted">16,938 CU</b>
          </div>
          <div className="bench-track">
            <div className="bench-fill passive-bar" style={{ width: '88%' }} />
          </div>
        </div>
      </div>
      <div className="bench-footer mono">
        <span className="pulse-dot" /> 27.3× CHEAPER · REPRICE BEFORE ARBITRAGE
      </div>
    </div>
  );
}

function VisualDynamicSpread() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <svg className="principle-svg" viewBox="0 0 240 70" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spreadGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--uni-accent1)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--uni-accent1)" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {/* Baseline s_floor line */}
        <line x1="10" y1="52" x2="230" y2="52" stroke="var(--uni-surface3)" strokeDasharray="3 3" />
        <text x="12" y="62" fill="var(--uni-neutral3)" fontSize="8" fontFamily="var(--uni-mono)">s_floor (5 bps)</text>
        {/* Dynamic Spread Wave: Calm -> Jump Spike -> Calm */}
        <path
          d="M 10 50 Q 50 48, 80 44 Q 110 38, 130 18 Q 145 12, 160 22 Q 180 42, 230 48 L 230 65 L 10 65 Z"
          fill="url(#spreadGrad)"
        />
        <path
          d="M 10 50 Q 50 48, 80 44 Q 110 38, 130 18 Q 145 12, 160 22 Q 180 42, 230 48"
          fill="none"
          stroke="var(--uni-accent1)"
          strokeWidth="2"
        />
        {/* Peak Callout */}
        <circle cx="130" cy="18" r="3.5" fill="var(--uni-accent1)" />
        <text x="136" y="18" fill="var(--uni-accent1)" fontSize="8.5" fontFamily="var(--uni-mono)">JUMP: ±48 bps</text>
      </svg>
      <div className="bench-footer mono">
        s_raw = s_floor + a₁·σ + a₂·|q| + a₅·jump
      </div>
    </div>
  );
}

function VisualProRataShares() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <div className="prorata-pool-grid">
        <div className="pool-pillar">
          <span className="mono pool-tag">SOL (B)</span>
          <div className="pillar-bar">
            <div className="pillar-fill sol-fill" style={{ height: '58%' }} />
          </div>
          <span className="mono pillar-val">50.0%</span>
        </div>
        <div className="pool-center-scale">
          <span className="mono scale-formula">q = 0.00</span>
          <div className="scale-needle" />
          <span className="mono scale-sub">D-05 INVARIANT</span>
        </div>
        <div className="pool-pillar">
          <span className="mono pool-tag">USDC (Q)</span>
          <div className="pillar-bar">
            <div className="pillar-fill usdc-fill" style={{ height: '58%' }} />
          </div>
          <span className="mono pillar-val">50.0%</span>
        </div>
      </div>
      <div className="bench-footer mono">
        NO ORACLE FOR DEPOSITS · ZERO ARBITRAGE SURFACE
      </div>
    </div>
  );
}

function VisualEpochQueues() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <div className="epoch-track-wrap">
        <div className="epoch-step done">
          <span className="mono step-slot">Slot T</span>
          <span className="step-node">●</span>
          <span className="step-label mono">Deposit</span>
        </div>
        <div className="epoch-connecting-bar">
          <span className="shield-tag mono">🛡️ 150 SLOTS WARMUP</span>
        </div>
        <div className="epoch-step active">
          <span className="mono step-slot">Slot T+150</span>
          <span className="step-node active-node">●</span>
          <span className="step-label mono">Active LP</span>
        </div>
      </div>
      <div className="bench-footer mono">
        BLOCKS JUST-IN-TIME (JIT) SANDWICH FLOW
      </div>
    </div>
  );
}

function VisualBoundedKeepers() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <svg className="principle-svg" viewBox="0 0 240 70" preserveAspectRatio="none">
        {/* Corridor Upper Bound */}
        <line x1="10" y1="16" x2="230" y2="16" stroke="var(--uni-critical)" strokeDasharray="3 3" strokeWidth="1.2" />
        <text x="12" y="12" fill="var(--uni-critical)" fontSize="7.5" fontFamily="var(--uni-mono)">s_max = 100 bps (REVERT BOUND)</text>
        {/* Corridor Lower Bound */}
        <line x1="10" y1="56" x2="230" y2="56" stroke="var(--uni-accent1)" strokeDasharray="3 3" strokeWidth="1.2" />
        <text x="12" y="65" fill="var(--uni-neutral3)" fontSize="7.5" fontFamily="var(--uni-mono)">s_min = 2 bps (MIN SPREAD)</text>
        {/* Keeper safe trajectory */}
        <path
          d="M 15 42 L 55 42 L 55 34 L 105 34 L 105 26 L 155 26 L 155 38 L 205 38 L 225 38"
          fill="none"
          stroke="var(--uni-accent1)"
          strokeWidth="2"
        />
        <circle cx="225" cy="38" r="3" fill="var(--uni-accent1)" />
      </svg>
      <div className="bench-footer mono">
        ON-CHAIN BOUNDED · CLAMP(s, s_min, s_max)
      </div>
    </div>
  );
}

function VisualMeasuredMarkouts() {
  return (
    <div className="principle-chart-box" aria-hidden="true">
      <svg className="principle-svg" viewBox="0 0 240 70" preserveAspectRatio="none">
        {/* Zero Markout Line */}
        <line x1="10" y1="36" x2="230" y2="36" stroke="var(--uni-surface3)" strokeWidth="1" />
        <text x="12" y="34" fill="var(--uni-neutral3)" fontSize="7.5" fontFamily="var(--uni-mono)">0.0 bps</text>
        {/* ArbSwap (+0.38 bps at +2s) Climbing Line */}
        <path
          d="M 20 36 Q 70 36, 110 24 T 220 18"
          fill="none"
          stroke="var(--uni-accent1)"
          strokeWidth="2.2"
        />
        <circle cx="220" cy="18" r="3" fill="var(--uni-accent1)" />
        <text x="145" y="15" fill="var(--uni-accent1)" fontSize="8" fontFamily="var(--uni-mono)">+0.38 bps (ArbSwap)</text>
        {/* Passive Pool (-0.23 bps) Declining Line */}
        <path
          d="M 20 36 Q 70 36, 110 48 T 220 54"
          fill="none"
          stroke="var(--uni-critical)"
          strokeWidth="1.8"
          strokeDasharray="4 2"
        />
        <text x="155" y="62" fill="var(--uni-critical)" fontSize="8" fontFamily="var(--uni-mono)">-0.23 bps (Passive)</text>
      </svg>
      <div className="bench-footer mono">
        6-WEEK EMPIRICAL REPLAY · LVR REDUCED 86%
      </div>
    </div>
  );
}

export const principles = [
  {
    number: '01 · ACTIVE REPRICING',
    title: 'Reprice without a trade.',
    line: 'A keeper writes small parameters on-chain for ~620 CU versus 16,938+ for a swap, keeping prices fresh before arbitrageurs strike.',
    badge: 'MATH §2 · 620 CU WRITE',
    formula: 'write_quote(P_res, s, q)',
    visual: <VisualActiveRepricing />,
  },
  {
    number: '02 · DYNAMIC SPREAD',
    title: 'Spread widens with uncertainty.',
    line: 'Half-spreads scale with short-term volatility, inventory imbalance, and oracle confidence intervals, defending the book.',
    badge: 'MATH §4 · EWMA VOL ESTIMATOR',
    formula: 's_raw = s_floor + a₁·σ + a₂·|q|',
    visual: <VisualDynamicSpread />,
  },
  {
    number: '03 · PRO-RATA SHARES',
    title: 'Oracle-free accounting.',
    line: 'Deposits and withdrawals are proportional in both tokens (v2-style), eliminating first-depositor and oracle-arbitrage manipulation surfaces.',
    badge: 'MATH §2 · DECISION D-05',
    formula: 'shares = min(dx·S/B, dy·S/Q)',
    visual: <VisualProRataShares />,
  },
  {
    number: '04 · EPOCH QUEUES',
    title: 'Block phantom liquidity.',
    line: '150-slot deposit warm-up and epoch withdrawal queues prevent just-in-time liquidity and frontrunning volatility jumps.',
    badge: 'MATH §7 · 150-SLOT WARMUP',
    formula: 'warmup_delay = 150 slots',
    visual: <VisualEpochQueues />,
  },
  {
    number: '05 · BOUNDED KEEPERS',
    title: 'Rule-bound execution.',
    line: 'The on-chain program validates bounds, staleness, and step caps. The keeper provides timeliness, but cannot set prices outside config.',
    badge: 'MATH §4 · BONDED KEEPER',
    formula: 'clamp(s_raw, s_min, s_max)',
    visual: <VisualBoundedKeepers />,
  },
  {
    number: '06 · MEASURED MARKOUTS',
    title: 'Empirical verification.',
    line: 'Pre-registered evaluation on 6 weeks of 1-second price paths confirms positive 2-second markouts (+0.38 bps) and 86% LVR reduction.',
    badge: 'MATH §6 · P1 REPLAY PROVEN',
    formula: 'Markout(t+2s) = +0.38 bps',
    visual: <VisualMeasuredMarkouts />,
  },
];

/* ─── HERO BACKGROUND: Aurora Blobs + Particle Network ───── */
function HeroBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const mouseRef  = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // ── Particle setup ──────────────────────────────────────
    const PARTICLE_COUNT = 72;
    const CONNECT_DIST   = 160;
    const SPEED          = 0.35;
    const MOUSE_REPEL    = 90;

    interface Particle {
      x: number; y: number;
      vx: number; vy: number;
      r: number; alpha: number;
    }

    let W = 0, H = 0;
    let particles: Particle[] = [];

    const resize = () => {
      W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
      H = canvas.height = canvas.offsetHeight * devicePixelRatio;
      // Rescale existing or recreate
      particles = Array.from({ length: PARTICLE_COUNT }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * SPEED,
        vy: (Math.random() - 0.5) * SPEED,
        r: Math.random() * 1.8 + 0.8,
        alpha: Math.random() * 0.5 + 0.3,
      }));
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // ── Colours ─────────────────────────────────────────────
    const TEAL   = '0,229,176';
    const CYAN   = '0,188,212';
    const INDIGO = '99,102,241';

    const draw = () => {
      ctx.clearRect(0, 0, W, H);

      // Update + draw particles
      for (const p of particles) {
        // Mouse repulsion
        const dx = p.x - mouseRef.current.x * devicePixelRatio;
        const dy = p.y - mouseRef.current.y * devicePixelRatio;
        const md = Math.hypot(dx, dy);
        if (md < MOUSE_REPEL * devicePixelRatio) {
          const force = (MOUSE_REPEL * devicePixelRatio - md) / (MOUSE_REPEL * devicePixelRatio);
          p.vx += (dx / md) * force * 0.4;
          p.vy += (dy / md) * force * 0.4;
        }

        // Speed cap + drag
        const spd = Math.hypot(p.vx, p.vy);
        if (spd > SPEED * 3) { p.vx *= 0.92; p.vy *= 0.92; }
        p.vx *= 0.998; p.vy *= 0.998;

        p.x += p.vx; p.y += p.vy;

        // Wrap edges
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;

        // Draw node dot
        const color = p.r > 1.8 ? TEAL : p.r > 1.2 ? CYAN : INDIGO;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color},${p.alpha})`;
        ctx.fill();

        // Node glow
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5 * devicePixelRatio);
        grd.addColorStop(0, `rgba(${color},${p.alpha * 0.4})`);
        grd.addColorStop(1, `rgba(${color},0)`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 5 * devicePixelRatio, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
      }

      // Draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < CONNECT_DIST * devicePixelRatio) {
            const opacity = (1 - dist / (CONNECT_DIST * devicePixelRatio)) * 0.18;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(${TEAL},${opacity})`;
            ctx.lineWidth = devicePixelRatio * 0.6;
            ctx.stroke();
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onMouseLeave = () => { mouseRef.current = { x: -9999, y: -9999 }; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  return (
    <div className="hero-bg" aria-hidden="true">
      {/* Layer 1: Aurora blobs (CSS animated) */}
      <div className="aurora-wrap">
        <div className="aurora-blob aurora-blob--1" />
        <div className="aurora-blob aurora-blob--2" />
        <div className="aurora-blob aurora-blob--3" />
        <div className="aurora-blob aurora-blob--4" />
      </div>

      {/* Layer 2: Particle node network (Canvas2D) */}
      <canvas ref={canvasRef} className="particle-canvas" />
    </div>
  );
}




const inView = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "0px 0px 12% 0px" },
  transition: { duration: 0.35 },
};

export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { quoteState, vaultState } = useProtocol();

  // Scroll targets for word-by-word reveal animations
  const manifestoRef = useRef<HTMLParagraphElement>(null);
  const { scrollYProgress: manifestoProgress } = useScroll({
    target: manifestoRef,
    offset: ["start 85%", "end 50%"],
  });

  const mechanicsRef = useRef<HTMLHeadingElement>(null);
  const { scrollYProgress: mechanicsProgress } = useScroll({
    target: mechanicsRef,
    offset: ["start 85%", "end 50%"],
  });

  return (
    <div className="overview-container">
      
      {/* 1. HERO SECTION */}
      <section className="hero" id="top">
        {/* Hero Background: Aurora Blobs + Particle Network */}
        <HeroBackground />
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

          <div className="scroll-cue" aria-hidden="true">
            <span>scroll</span>
            <i />
          </div>
        </div>
      </section>

      {/* 2. INFINITE SCROLLING TICKER / MARQUEE */}
      <div className="protocol-ticker-wrap" aria-hidden="true">
        <div className="protocol-ticker-track">
          <span>ARBSWAP ON-CHAIN PROPAMM</span>
          <span className="ticker-bullet">·</span>
          <span>~620 COMPUTE UNITS PER UPDATE</span>
          <span className="ticker-bullet">·</span>
          <span>0.00 BPS QUOTE-VERSUS-FILL GAP</span>
          <span className="ticker-bullet">·</span>
          <span>LVR DEPTH THROTTLED BY σ²</span>
          <span className="ticker-bullet">·</span>
          <span>PYTH HIGH-PRECISION ORACLE</span>
          <span className="ticker-bullet">·</span>
          <span>150-SLOT LIQUIDITY WARM-UP</span>
          <span className="ticker-bullet">·</span>
          <span>+0.38 BPS EMPIRICAL MARKOUT</span>
          <span className="ticker-bullet">·</span>
          {/* Loop duplicate */}
          <span>ARBSWAP ON-CHAIN PROPAMM</span>
          <span className="ticker-bullet">·</span>
          <span>~620 COMPUTE UNITS PER UPDATE</span>
          <span className="ticker-bullet">·</span>
          <span>0.00 BPS QUOTE-VERSUS-FILL GAP</span>
          <span className="ticker-bullet">·</span>
          <span>LVR DEPTH THROTTLED BY σ²</span>
          <span className="ticker-bullet">·</span>
          <span>PYTH HIGH-PRECISION ORACLE</span>
          <span className="ticker-bullet">·</span>
          <span>150-SLOT LIQUIDITY WARM-UP</span>
          <span className="ticker-bullet">·</span>
          <span>+0.38 BPS EMPIRICAL MARKOUT</span>
          <span className="ticker-bullet">·</span>
        </div>
      </div>

      {/* 3. LIVE METRICS RIBBON */}
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

      {/* 4. MANIFESTO / THESIS WITH WORD-BY-WORD SCROLL REVEAL */}
      <section className="manifesto-section" aria-labelledby="thesis-title">
        <p className="section-index">/ 01 · The Thesis</p>
        <p ref={manifestoRef} id="thesis-title" className="manifesto-statement">
          {manifestoWords.map((word, index) => (
            <RevealedWord
              key={`${word.text}-${index}`}
              word={word}
              index={index}
              total={manifestoWords.length}
              progress={manifestoProgress}
            />
          ))}
        </p>
      </section>

      {/* 5. THE PROBLEM COMPARISON */}
      <section className="problem-section" id="problem">
        <div className="problem-heading">
          <p className="section-index">/ 02 · The Problem</p>
          <h2>
            Passive pools bleed LVR. <em>propAMMs exploit execution.</em>
          </h2>
          <p>
            Passive capital bleeds to latency arbitrage, while closed propAMMs conceal execution risk. ArbSwap unifies open pooled capital with active on-chain quoting.
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

      {/* 6. MECHANICS SECTION WITH SCROLL-REVEALED STATEMENT */}
      <section className="geometry-section" id="mechanics">
        <div className="geometry-heading">
          <p className="section-index">/ 03 · Mechanics & Core Math</p>
          <div className="geometry-statement">
            <h2 ref={mechanicsRef} id="mechanics-title">
              {mechanicsWords.map((word, index) => (
                <RevealedWord
                  key={`${word.text}-${index}`}
                  word={word}
                  index={index}
                  total={mechanicsWords.length}
                  progress={mechanicsProgress}
                />
              ))}
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
                {pr.visual}
              </div>
              <div className="principle-meta-row">
                <span className="card-number">{pr.number}</span>
                <span className="principle-badge mono">{pr.badge}</span>
              </div>
              <h3>{pr.title}</h3>
              <p className="principle-line">{pr.line}</p>
              <div className="principle-formula-pill mono">
                <code>{pr.formula}</code>
              </div>
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
          gap: 130px;
          padding-bottom: 80px;
        }

        .section-index {
          font: 500 10.5px var(--uni-mono);
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: var(--uni-neutral3);
          display: block;
          margin-bottom: 26px;
        }

        /* ─── HERO BACKGROUND ─────────────────────── */
        .hero-bg {
          position: absolute;
          inset: 0;
          z-index: 1;
          overflow: hidden;
          pointer-events: none;
          -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent 100%);
          mask-image: linear-gradient(to bottom, #000 60%, transparent 100%);
        }

        /* Layer 1: Aurora blobs */
        .aurora-wrap {
          position: absolute;
          inset: 0;
        }
        .aurora-blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          mix-blend-mode: screen;
          opacity: 0.55;
        }
        .aurora-blob--1 {
          width: 700px; height: 700px;
          background: radial-gradient(circle, rgba(0,229,176,0.32) 0%, transparent 70%);
          top: -200px; left: -180px;
          animation: blob-drift-1 18s ease-in-out infinite alternate;
        }
        .aurora-blob--2 {
          width: 600px; height: 600px;
          background: radial-gradient(circle, rgba(0,188,212,0.28) 0%, transparent 70%);
          top: -100px; right: -150px;
          animation: blob-drift-2 22s ease-in-out infinite alternate;
        }
        .aurora-blob--3 {
          width: 500px; height: 500px;
          background: radial-gradient(circle, rgba(99,102,241,0.20) 0%, transparent 70%);
          bottom: -150px; left: 30%;
          animation: blob-drift-3 26s ease-in-out infinite alternate;
        }
        .aurora-blob--4 {
          width: 400px; height: 400px;
          background: radial-gradient(circle, rgba(0,229,176,0.15) 0%, transparent 70%);
          bottom: -80px; right: 10%;
          animation: blob-drift-4 20s ease-in-out infinite alternate;
        }
        @keyframes blob-drift-1 {
          from { transform: translate(0,   0)   scale(1);    }
          to   { transform: translate(80px, 60px) scale(1.15); }
        }
        @keyframes blob-drift-2 {
          from { transform: translate(0,   0)    scale(1);    }
          to   { transform: translate(-60px, 80px) scale(0.9);  }
        }
        @keyframes blob-drift-3 {
          from { transform: translate(0, 0)    scale(1);   }
          to   { transform: translate(40px, -50px) scale(1.1); }
        }
        @keyframes blob-drift-4 {
          from { transform: translate(0, 0)     scale(1);    }
          to   { transform: translate(-40px, 30px) scale(1.2); }
        }

        /* Layer 2: Particle canvas */
        .particle-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }

        /* Hero */
        .hero {
          position: relative;
          display: grid;
          min-height: 90svh;
          place-items: center;
          text-align: center;
          padding: 100px 24px 60px;
          overflow: hidden;
        }
        .hero::after {
          content: '';
          position: absolute;
          inset: auto 0 0 0;
          height: 180px;
          background: linear-gradient(to bottom, transparent, var(--uni-surface1));
          pointer-events: none;
          z-index: 1;
        }
        .hero-content {
          position: relative;
          z-index: 2;
          max-width: 1080px;
          margin: 0 auto;
        }
        .eyebrow {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          margin-bottom: 28px;
          font: 500 10.5px var(--uni-mono);
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: var(--uni-neutral3);
        }
        .eyebrow b {
          width: 6px;
          height: 6px;
          border-radius: 99px;
          background: var(--uni-accent1);
          box-shadow: 0 0 10px var(--uni-accent1);
        }
        .eyebrow span {
          opacity: 0.45;
        }
        .hero-title {
          font-size: clamp(4rem, 8.5vw, 8.6rem);
          font-weight: 500;
          letter-spacing: -0.08em;
          line-height: 0.89;
          margin: 0 auto 30px;
          max-width: 13ch;
        }
        .hero-lead {
          max-width: 54ch;
          margin: 0 auto 32px;
          color: var(--uni-neutral2);
          font-size: clamp(16px, 1.6vw, 20px);
          line-height: 1.65;
        }
        .hero-live {
          color: var(--uni-neutral3);
          font: 11px var(--uni-mono);
          letter-spacing: 0.12em;
          text-transform: uppercase;
          margin-bottom: 38px;
        }
        .hero-actions {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 20px;
          flex-wrap: wrap;
        }

        .scroll-cue {
          margin: 40px auto 0;
          display: inline-grid;
          justify-items: center;
          gap: 10px;
          color: var(--uni-neutral3);
          font: 10px var(--uni-mono);
          letter-spacing: 0.28em;
          text-transform: uppercase;
          pointer-events: none;
        }
        .scroll-cue i {
          width: 1px;
          height: 38px;
          background: linear-gradient(var(--uni-neutral3), transparent);
          animation: cue-pulse 2s ease-in-out infinite;
        }
        @keyframes cue-pulse {
          0%, 100% { opacity: 0.3; transform: scaleY(0.7); }
          50% { opacity: 1; transform: scaleY(1); }
        }

        /* Primary CTA — solid filled */
        .button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 15px 30px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.19em;
          text-transform: uppercase;
          transition: background 0.25s, color 0.25s, transform 0.25s, box-shadow 0.25s;
          cursor: pointer;
          border: 1px solid var(--uni-accent1);
        }
        .button-solid {
          background: var(--uni-accent1);
          color: var(--uni-on-accent);
          box-shadow: 0 0 24px rgba(0, 229, 176, 0.25);
        }
        .button-solid:hover {
          background: var(--uni-accent1-hover);
          box-shadow: 0 0 36px rgba(0, 229, 176, 0.45);
          transform: translateY(-2px);
        }
        .button-solid:active {
          transform: translateY(0);
        }

        /* Ghost / text-link secondary CTA */
        .underlink {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding-bottom: 7px;
          border-bottom: 1px solid var(--uni-neutral3);
          font: 500 11px var(--uni-mono);
          letter-spacing: 0.17em;
          text-transform: uppercase;
          color: var(--uni-neutral2);
          background: transparent;
          transition: color 0.2s, border-color 0.2s;
          cursor: pointer;
        }
        .underlink:hover {
          color: var(--uni-neutral1);
          border-bottom-color: var(--uni-neutral1);
        }

        /* Continuous Infinite Ticker Marquee */
        .protocol-ticker-wrap {
          width: 100vw;
          margin-left: calc(-50vw + 50%);
          margin-right: calc(-50vw + 50%);
          overflow: hidden;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(255, 255, 255, 0.012);
          padding: 16px 0;
          white-space: nowrap;
          user-select: none;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
        }
        .protocol-ticker-track {
          display: inline-flex;
          align-items: center;
          gap: 28px;
          animation: ticker-slide 34s linear infinite;
          font-family: var(--uni-mono);
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: var(--uni-neutral2);
        }
        .ticker-bullet {
          color: var(--uni-accent1);
          opacity: 0.7;
        }
        @keyframes ticker-slide {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
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
          padding: 28px;
          border: 1px solid var(--uni-surface3);
          border-radius: 24px;
          background: var(--uni-surface1);
          display: flex;
          flex-direction: column;
          gap: 6px;
          transition: border-color 0.2s;
        }
        .ribbon-card:hover {
          border-color: rgba(255, 255, 255, 0.22);
        }
        .ribbon-label {
          font-size: 10.5px;
          font-family: var(--uni-mono);
          text-transform: uppercase;
          color: var(--uni-neutral3);
          letter-spacing: 0.15em;
        }
        .ribbon-val {
          font-size: 32px;
          font-weight: 600;
          letter-spacing: -0.03em;
        }
        .ribbon-sub {
          font-size: 12.5px;
          color: var(--uni-neutral2);
        }

        /* Manifesto Statement with Word-by-Word Reveal */
        .manifesto-section {
          padding: clamp(70px, 9vw, 130px) 0;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .manifesto-statement {
          max-width: 34ch;
          font-size: clamp(2.6rem, 5vw, 5.2rem);
          font-weight: 500;
          line-height: 1.05;
          letter-spacing: -0.05em;
          color: var(--uni-neutral1);
        }

        /* Problem Section */
        .problem-section, .geometry-section, .protocol-section, .modules-section {
          padding: 40px 0 0;
        }
        .problem-heading {
          max-width: 1120px;
          margin-bottom: 64px;
        }
        .problem-heading h2 {
          font-size: clamp(3.4rem, 6.4vw, 7.2rem);
          font-weight: 500;
          letter-spacing: -0.08em;
          line-height: 0.9;
          margin-bottom: 24px;
          max-width: 15ch;
        }
        .problem-heading h2 em {
          color: var(--uni-neutral2);
          font-style: italic;
          font-weight: 500;
        }
        .problem-heading p {
          color: var(--uni-neutral2);
          font-size: clamp(15px, 1.5vw, 18px);
          line-height: 1.65;
          max-width: 56ch;
        }
        .problem-grid, .geometry-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .problem-card, .geometry-panel {
          display: flex;
          flex-direction: column;
          min-height: 440px;
          padding: 28px;
          border: 1px solid var(--uni-surface3);
          border-radius: 22px;
          background: color-mix(in srgb, var(--uni-neutral1) 3%, transparent);
          transition: border-color 0.25s, background 0.25s, transform 0.25s;
        }
        .problem-card:hover, .geometry-panel:hover {
          border-color: rgba(255, 255, 255, 0.24);
          background: color-mix(in srgb, var(--uni-neutral1) 4.8%, transparent);
          transform: translateY(-3px);
        }
        .card-rule {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin: -28px -28px 24px;
          padding: 16px 28px;
          border-bottom: 1px dashed var(--uni-surface3);
          font: 10px var(--uni-mono);
          letter-spacing: 0.17em;
          text-transform: uppercase;
          color: var(--uni-neutral3);
        }
        .problem-card h3, .geometry-panel h3 {
          font-size: clamp(1.4rem, 1.9vw, 2.0rem);
          font-weight: 500;
          letter-spacing: -0.05em;
          line-height: 1.15;
          margin-bottom: 18px;
        }
        .equation {
          display: grid;
          min-height: 60px;
          margin: 0 0 20px;
          padding: 12px 18px;
          place-items: center;
          border: 1px dashed var(--uni-surface3);
          border-radius: 12px;
          font-size: clamp(1.05rem, 1.35vw, 1.35rem);
          text-align: center;
        }
        .problem-lead, .geometry-panel p {
          font-size: clamp(13.5px, 1.1vw, 15px);
          letter-spacing: -0.01em;
          line-height: 1.55;
          color: var(--uni-neutral2);
          margin-bottom: 18px;
        }
        .card-footer-note {
          margin-top: auto;
          padding-top: 18px;
          border-top: 1px dashed var(--uni-surface3);
          font-size: 11.5px;
          color: var(--uni-neutral3);
        }

        /* Geometry mechanics */
        .geometry-statement {
          max-width: 1120px;
          margin: 0 0 54px;
        }
        .geometry-statement h2 {
          font-size: clamp(3.2rem, 6vw, 6.8rem);
          font-weight: 500;
          letter-spacing: -0.075em;
          line-height: 0.94;
          max-width: 19ch;
          color: var(--uni-neutral1);
        }

        /* Protocol 6-card grid */
        .protocol-section h2 {
          font-size: clamp(3.4rem, 6.4vw, 7.2rem);
          font-weight: 500;
          letter-spacing: -0.08em;
          line-height: 0.9;
          margin-bottom: 24px;
        }
        .protocol-section h2 em {
          color: var(--uni-neutral2);
          font-style: italic;
          font-weight: 500;
        }
        .principle-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
        }
        .principle-card {
          display: flex;
          flex-direction: column;
          padding: 30px;
          border: 1px solid var(--uni-surface3);
          border-radius: 26px;
          background: color-mix(in srgb, var(--uni-neutral1) 3%, transparent);
          min-height: 480px;
          transition: transform 0.25s, border-color 0.25s, box-shadow 0.25s;
          overflow: hidden;
        }
        .principle-card:hover {
          transform: translateY(-4px);
          border-color: rgba(255, 255, 255, 0.25);
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
        }

        /* Top Pictorial & Graph Visual Box */
        .principle-visual-box {
          height: 145px;
          margin: -30px -30px 22px;
          padding: 16px 20px;
          border-bottom: 1px dashed var(--uni-surface3);
          background: color-mix(in srgb, var(--uni-neutral1) 1.5%, transparent);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }
        .principle-chart-box {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }
        .principle-svg {
          width: 100%;
          height: 78px;
          overflow: visible;
        }

        /* Benchmark Bars (Card 1) */
        .bench-bars-wrap {
          display: flex;
          flex-direction: column;
          gap: 9px;
          margin-top: 4px;
        }
        .bench-row {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .bench-meta {
          display: flex;
          justify-content: space-between;
          font-size: 9.5px;
          letter-spacing: 0.1em;
          color: var(--uni-neutral3);
        }
        .bench-track {
          height: 10px;
          background: var(--uni-surface2);
          border-radius: 5px;
          overflow: hidden;
          border: 1px solid var(--uni-surface3);
        }
        .bench-fill {
          height: 100%;
          border-radius: 5px;
          transition: width 0.4s ease;
        }
        .keeper-bar {
          background: var(--uni-accent1);
          box-shadow: 0 0 10px var(--uni-accent1);
        }
        .passive-bar {
          background: var(--uni-critical);
          opacity: 0.8;
        }
        .bench-footer {
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 9px;
          letter-spacing: 0.12em;
          color: var(--uni-neutral3);
          text-transform: uppercase;
          border-top: 1px dashed rgba(255, 255, 255, 0.08);
          padding-top: 6px;
        }
        .pulse-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--uni-accent1);
          box-shadow: 0 0 8px var(--uni-accent1);
          animation: cue-pulse 1.8s infinite;
        }

        /* Pro-rata Twin Pool Pillar (Card 3) */
        .prorata-pool-grid {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 12px;
          height: 80px;
        }
        .pool-pillar {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .pool-tag {
          font-size: 9px;
          color: var(--uni-neutral3);
          letter-spacing: 0.1em;
        }
        .pillar-bar {
          width: 32px;
          height: 48px;
          background: var(--uni-surface2);
          border: 1px solid var(--uni-surface3);
          border-radius: 6px;
          display: flex;
          align-items: flex-end;
          overflow: hidden;
        }
        .pillar-fill {
          width: 100%;
          border-radius: 4px 4px 0 0;
        }
        .sol-fill {
          background: linear-gradient(to top, #9945FF, #14F195);
        }
        .usdc-fill {
          background: linear-gradient(to top, #2775CA, #5495E6);
        }
        .pillar-val {
          font-size: 9.5px;
          color: var(--uni-neutral2);
        }
        .pool-center-scale {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
        }
        .scale-formula {
          font-size: 11px;
          color: var(--uni-accent1);
          font-weight: 600;
        }
        .scale-needle {
          width: 24px;
          height: 2px;
          background: var(--uni-accent1);
          box-shadow: 0 0 6px var(--uni-accent1);
        }
        .scale-sub {
          font-size: 8px;
          color: var(--uni-neutral3);
          letter-spacing: 0.08em;
        }

        /* Epoch Timeline (Card 4) */
        .epoch-track-wrap {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 4px;
          height: 80px;
        }
        .epoch-step {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
        }
        .step-slot {
          font-size: 8.5px;
          color: var(--uni-neutral3);
          letter-spacing: 0.08em;
        }
        .step-node {
          font-size: 12px;
          color: var(--uni-neutral3);
        }
        .active-node {
          color: var(--uni-accent1);
          text-shadow: 0 0 8px var(--uni-accent1);
        }
        .step-label {
          font-size: 9.5px;
          color: var(--uni-neutral2);
        }
        .epoch-connecting-bar {
          flex: 1;
          margin: 0 8px;
          height: 22px;
          border: 1px dashed var(--uni-surface3);
          background: color-mix(in srgb, var(--uni-neutral1) 2%, transparent);
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .shield-tag {
          font-size: 8px;
          letter-spacing: 0.1em;
          color: var(--uni-accent1);
        }

        /* Principle Metadata & Typography */
        .principle-meta-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .card-number {
          font: 500 10.5px var(--uni-mono);
          color: var(--uni-neutral3);
          text-transform: uppercase;
          letter-spacing: 0.16em;
          margin: 0;
        }
        .principle-badge {
          font-size: 9px;
          letter-spacing: 0.12em;
          color: var(--uni-accent1);
          background: var(--uni-accent2);
          border: 1px solid rgba(0, 229, 176, 0.25);
          padding: 3px 8px;
          border-radius: 100px;
        }
        .principle-card h3 {
          font-size: clamp(1.8rem, 2.5vw, 2.5rem);
          font-weight: 500;
          letter-spacing: -0.055em;
          line-height: 1.02;
          margin-bottom: 14px;
          color: var(--uni-neutral1);
        }
        .principle-line {
          font-size: 14px;
          line-height: 1.62;
          color: var(--uni-neutral2);
          margin-bottom: 20px;
          flex: 1;
        }
        .principle-formula-pill {
          margin-top: auto;
          padding: 8px 14px;
          border-radius: 10px;
          background: var(--uni-surface2);
          border: 1px dashed var(--uni-surface3);
          font-size: 11px;
          color: var(--uni-accent1);
          letter-spacing: 0.05em;
          width: fit-content;
        }
        .principle-formula-pill code {
          font-family: var(--uni-mono);
        }

        /* Modules */
        .modules-section h2 {
          font-size: clamp(3.4rem, 6.4vw, 7.2rem);
          font-weight: 500;
          letter-spacing: -0.08em;
          line-height: 0.9;
          margin-bottom: 24px;
        }
        .modules-section h2 em {
          color: var(--uni-neutral2);
          font-style: italic;
          font-weight: 500;
        }
        .modules-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 18px;
        }
        .module-box {
          padding: 34px;
          border: 1px solid var(--uni-surface3);
          border-radius: 26px;
          background: color-mix(in srgb, var(--uni-neutral1) 3%, transparent);
          cursor: pointer;
          display: flex;
          flex-direction: column;
          transition: all 0.25s ease;
        }
        .module-box:hover {
          border-color: var(--uni-accent1);
          transform: translateY(-4px);
          background: color-mix(in srgb, var(--uni-accent1) 6%, transparent);
        }
        .module-tag {
          font-size: 11px;
          color: var(--uni-accent1);
          letter-spacing: 0.14em;
          margin-bottom: 12px;
        }
        .module-box h3 {
          font-size: clamp(1.8rem, 2.4vw, 2.6rem);
          font-weight: 500;
          letter-spacing: -0.05em;
          line-height: 1;
          margin-bottom: 12px;
        }
        .module-box p {
          font-size: 14px;
          line-height: 1.62;
          color: var(--uni-neutral2);
          margin-bottom: 24px;
        }
        .module-link {
          margin-top: auto;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--uni-accent1);
        }

        /* Gateway section */
        .gateway-section {
          position: relative;
          display: grid;
          min-height: 70svh;
          place-items: center;
          text-align: center;
          overflow: hidden;
          padding: 110px 24px;
          border-top: 1px solid var(--uni-surface3);
        }
        .gateway-bg-text {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: clamp(8rem, 20vw, 24rem);
          font-weight: 600;
          color: transparent;
          -webkit-text-stroke: 1px rgba(255, 255, 255, 0.04);
          pointer-events: none;
          letter-spacing: -0.1em;
          white-space: nowrap;
          user-select: none;
        }
        .gateway-content {
          position: relative;
          z-index: 2;
          max-width: 820px;
        }
        .gateway-content h2 {
          font-size: clamp(3.2rem, 6.2vw, 6.6rem);
          font-weight: 500;
          letter-spacing: -0.07em;
          line-height: 0.94;
          margin: 14px 0 20px;
        }
        .gateway-content h2 em {
          color: var(--uni-neutral2);
          font-style: italic;
          font-weight: 500;
        }
        .gateway-content p {
          color: var(--uni-neutral2);
          font-size: clamp(16px, 1.6vw, 19px);
          line-height: 1.65;
          margin-bottom: 38px;
        }

        /* Footer */
        .site-footer {
          border-top: 1px solid var(--uni-surface3);
          padding-top: 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: var(--uni-neutral3);
          font: 11px var(--uni-mono);
          letter-spacing: 0.12em;
          text-transform: uppercase;
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
            gap: 14px;
            text-align: center;
          }
        }
      `}</style>
    </div>
  );
};
