import React, { useEffect, useMemo, useState } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  ShieldAlert, 
  Activity, 
  TrendingUp, 
  CheckCircle2 
} from 'lucide-react';
import streams from '../data/demoStreams.json';

/**
 * S2-38 Phase 3: deterministic, offline demo. The frames come from the generated
 * bundle (`app/src/data/demoStreams.json`, produced by
 * `simulation.attackers.export_streams`) imported at build time — so the page
 * makes no runtime network call, no wallet connection and no transaction.
 */
interface ScenarioStream { 
  mid: number[]; 
  arbSwap: number[]; 
  passive: number[]; 
  events: Record<string, string>; 
}

const STREAMS = (streams as { meta: { label: string; seed: number }; streams: Record<string, ScenarioStream> });

interface ScenarioMeta {
  title: string;
  category: 'Normal' | 'Adverse Vol' | 'Adversarial Attack';
  desc: string;
}

const SCENARIO_DETAILS: Record<string, ScenarioMeta> = {
  calm: {
    title: 'Calm Market',
    category: 'Normal',
    desc: 'Low-volatility flow; ArbSwap earns half-spread, passive pool bleeds continuous LVR.',
  },
  trend: {
    title: 'Directional Drift',
    category: 'Normal',
    desc: 'Persistent directional trend; ArbSwap inventory skew automatically shifts quote ladder.',
  },
  crash: {
    title: 'Flash Vol Crash',
    category: 'Adverse Vol',
    desc: 'Fast adverse move; per-window flow cap and volatility throttle protect LP capital.',
  },
  jump: {
    title: 'Anchor Jump Guard',
    category: 'Adverse Vol',
    desc: 'Sudden price jump; anchor-step guard rejects anomalous remints beyond max bps.',
  },
  freeze: {
    title: 'Oracle Stall Attack',
    category: 'Adversarial Attack',
    desc: 'Attack: Oracle publishing stalls; staleness circuit breaker activates and halts quoting.',
  },
  kill: {
    title: 'Keeper Timeout (Kill)',
    category: 'Adversarial Attack',
    desc: 'Attack: Keeper halts commits; quotes expire gracefully on-chain; zero stale executions.',
  },
  bot: {
    title: 'Latency Arbitrage Bot',
    category: 'Adversarial Attack',
    desc: 'Attack: Arbitrage bot blasts stale prices; dynamic flow cap binds and prevents draining.',
  },
  malicious: {
    title: 'Malicious Keeper Spike',
    category: 'Adversarial Attack',
    desc: 'Attack: Keeper attempts max boundary anchoring; edge circuit breaker trips instantly.',
  },
};

export const SimulatorPage: React.FC = () => {
  const ids = useMemo(() => Object.keys(STREAMS.streams), []);
  const [scenario, setScenario] = useState<string>(ids[0] ?? 'calm');
  const [step, setStep] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(true);
  const [speed, setSpeed] = useState<number>(1);

  const data = STREAMS.streams[scenario] ?? STREAMS.streams[ids[0]];
  const n = data.mid.length;

  useEffect(() => { 
    setStep(0); 
  }, [scenario]);

  useEffect(() => {
    if (!playing) return;
    const intervalMs = Math.round(180 / speed);
    const id = setInterval(() => {
      setStep((s) => (s + 1) % n);
    }, intervalMs);
    return () => clearInterval(id);
  }, [playing, speed, n]);

  const W = 620;
  const H = 140;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 22;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const currentMid = data.mid[step] ?? data.mid[0];
  const currentArb = data.arbSwap[step] ?? 0;
  const currentPassive = data.passive[step] ?? 0;
  const alphaDelta = currentArb - currentPassive;
  const event = data.events[String(step)];

  // Mid price scale
  const minMid = Math.min(...data.mid);
  const maxMid = Math.max(...data.mid);
  const midRange = Math.max(0.001, maxMid - minMid);
  const getMidX = (i: number) => padL + (i / Math.max(1, n - 1)) * chartW;
  const getMidY = (v: number) => padT + chartH - ((v - minMid) / midRange) * chartH;

  const midSlice = data.mid.slice(0, step + 1);
  const midPath = midSlice.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getMidX(i).toFixed(1)} ${getMidY(v).toFixed(1)}`).join(' ');
  const midAreaPath = midSlice.length > 0
    ? `${midPath} L ${getMidX(midSlice.length - 1).toFixed(1)} ${padT + chartH} L ${padL} ${padT + chartH} Z`
    : '';

  // PnL scale
  const allPnls = [...data.arbSwap, ...data.passive];
  const minPnl = Math.min(...allPnls);
  const maxPnl = Math.max(...allPnls);
  const pnlRange = Math.max(0.001, maxPnl - minPnl);
  const getPnlY = (v: number) => padT + chartH - ((v - minPnl) / pnlRange) * chartH;

  const arbSlice = data.arbSwap.slice(0, step + 1);
  const passiveSlice = data.passive.slice(0, step + 1);
  const arbPath = arbSlice.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getMidX(i).toFixed(1)} ${getPnlY(v).toFixed(1)}`).join(' ');
  const passivePath = passiveSlice.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getMidX(i).toFixed(1)} ${getPnlY(v).toFixed(1)}`).join(' ');

  const currentMeta = SCENARIO_DETAILS[scenario] ?? {
    title: scenario,
    category: 'Normal',
    desc: 'Deterministic scenario replay',
  };

  return (
    <div className="sim-page-wrapper">
      <div className="sim-container">
        {/* Header */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h1 className="uni-headline" style={{ margin: 0, textAlign: 'left' }}>Market Microstructure Simulator</h1>
            <span className="mono" style={{ fontSize: 11, background: 'rgba(0, 229, 176, 0.1)', color: '#00e5b0', border: '1px solid rgba(0, 229, 176, 0.3)', padding: '2px 8px', borderRadius: 6 }}>
              OFFLINE REPLAY
            </span>
          </div>
          <p className="uni-subheadline" style={{ textAlign: 'left', margin: 0 }}>
            Deterministic Monte-Carlo flow engine comparing ArbSwap vs Passive AMM under volatility & adversarial attack regimes ({STREAMS.meta.label}, seed {STREAMS.meta.seed}).
          </p>
        </div>

        {/* Scenarios Grid */}
        <div className="sim-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--uni-neutral2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Select Market Scenario / Attack Vector
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--uni-neutral3)' }}>{ids.length} scenarios available</span>
          </div>
          <div className="scenarios-grid">
            {ids.map((id) => {
              const meta = SCENARIO_DETAILS[id] ?? { title: id, category: 'Normal', desc: '' };
              const isSelected = scenario === id;
              const isAttack = meta.category === 'Adversarial Attack';
              const isAdverse = meta.category === 'Adverse Vol';

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setScenario(id)}
                  className={`scenario-btn ${isSelected ? 'active' : ''}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{meta.title}</span>
                    <span className="mono" style={{ 
                      fontSize: 9.5, 
                      padding: '1px 6px', 
                      borderRadius: 4,
                      background: isAttack ? 'rgba(255, 89, 60, 0.15)' : isAdverse ? 'rgba(245, 158, 11, 0.15)' : 'rgba(0, 229, 176, 0.15)',
                      color: isAttack ? '#ff593c' : isAdverse ? '#f59e0b' : '#00e5b0',
                      border: `1px solid ${isAttack ? 'rgba(255, 89, 60, 0.3)' : isAdverse ? 'rgba(245, 158, 11, 0.3)' : 'rgba(0, 229, 176, 0.3)'}`
                    }}>
                      {meta.category}
                    </span>
                  </div>
                  <p style={{ fontSize: 11.5, color: isSelected ? 'var(--uni-neutral1)' : 'var(--uni-neutral3)', margin: 0, textAlign: 'left', lineHeight: 1.35 }}>
                    {meta.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Live Simulation Cockpit */}
        <div className="sim-card cockpit-card">
          {/* Controls Bar */}
          <div className="cockpit-toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="cockpit-btn primary"
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
                <span>{playing ? 'Pause' : 'Play'}</span>
              </button>
              <button
                type="button"
                className="cockpit-btn"
                onClick={() => setStep(0)}
                title="Reset simulation to step 0"
              >
                <RotateCcw size={13} />
                <span>Reset</span>
              </button>
            </div>

            {/* Scrubber timeline */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, maxWidth: 380, margin: '0 16px' }}>
              <span className="mono text-muted" style={{ fontSize: 11 }}>Frame</span>
              <input
                type="range"
                min={0}
                max={n - 1}
                value={step}
                onChange={(e) => setStep(Number(e.target.value))}
                style={{ flex: 1, accentColor: '#00e5b0', cursor: 'pointer' }}
              />
              <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral1)', minWidth: 64, textAlign: 'right' }}>
                {step + 1} / {n}
              </span>
            </div>

            {/* Speed toggle pills */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.3)', padding: 3, borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
              {[1, 2, 4].map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setSpeed(spd)}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    fontFamily: 'var(--uni-mono)',
                    fontWeight: 600,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: speed === spd ? 'rgba(0, 229, 176, 0.2)' : 'transparent',
                    color: speed === spd ? '#00e5b0' : 'rgba(255,255,255,0.6)',
                    border: speed === spd ? '1px solid rgba(0, 229, 176, 0.3)' : '1px solid transparent',
                  }}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>

          {/* Event Alert Banner */}
          {event ? (
            <div className="event-alert-box alert">
              <ShieldAlert size={18} color="#f59e0b" />
              <div>
                <strong className="mono" style={{ color: '#f59e0b', fontSize: 12 }}>TRIGGER EVENT AT STEP {step}:</strong>
                <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#fff' }}>{event}</p>
              </div>
            </div>
          ) : (
            <div className="event-alert-box nominal">
              <CheckCircle2 size={16} color="#00e5b0" />
              <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>
                Guards active · Constant-product ladder anchored within dynamic risk budget · No breaker violations
              </span>
            </div>
          )}

          {/* Visual Charts Split */}
          <div className="sim-charts-grid">
            
            {/* Chart 1: Mid Price Track */}
            <div className="sim-chart-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Activity size={14} color="#00e5b0" />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>Pyth Reference Mid Price</span>
                </div>
                <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: '#00e5b0' }}>
                  ${currentMid.toFixed(2)}
                </span>
              </div>

              <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', padding: '6px 4px' }}>
                <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={120} style={{ display: 'block', overflow: 'visible' }}>
                  <defs>
                    <linearGradient id="simMidArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00e5b0" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#00e5b0" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  
                  {/* Grid lines */}
                  <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
                  <line x1={padL} y1={padT + chartH / 2} x2={W - padR} y2={padT + chartH / 2} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
                  <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="rgba(255,255,255,0.1)" />

                  <text x={padL - 6} y={padT + 4} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="9" fontFamily="var(--uni-mono)">
                    ${maxMid.toFixed(1)}
                  </text>
                  <text x={padL - 6} y={padT + chartH + 3} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="9" fontFamily="var(--uni-mono)">
                    ${minMid.toFixed(1)}
                  </text>

                  {/* Area & Line */}
                  <path d={midAreaPath} fill="url(#simMidArea)" />
                  <path d={midPath} fill="none" stroke="#00e5b0" strokeWidth="2" strokeLinecap="round" />

                  {/* Current step cursor */}
                  {step < n && (
                    <circle cx={getMidX(step)} cy={getMidY(currentMid)} r="4" fill="#00e5b0" stroke="#fff" strokeWidth="1.5" />
                  )}
                </svg>
              </div>
            </div>

            {/* Chart 2: Cumulative PnL Comparison */}
            <div className="sim-chart-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TrendingUp size={14} color="#00e5b0" />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>Cumulative LP PnL Comparison</span>
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: 'var(--uni-mono)' }}>
                  <span style={{ color: '#00e5b0' }}>● Arb: {currentArb >= 0 ? '+' : ''}{currentArb.toFixed(2)}</span>
                  <span style={{ color: '#ff593c' }}>● Passive: {currentPassive >= 0 ? '+' : ''}{currentPassive.toFixed(2)}</span>
                </div>
              </div>

              <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', padding: '6px 4px' }}>
                <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={120} style={{ display: 'block', overflow: 'visible' }}>
                  {/* Grid lines */}
                  <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
                  <line x1={padL} y1={padT + chartH / 2} x2={W - padR} y2={padT + chartH / 2} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
                  <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="rgba(255,255,255,0.1)" />

                  <text x={padL - 6} y={padT + 4} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="9" fontFamily="var(--uni-mono)">
                    +{maxPnl.toFixed(1)}
                  </text>
                  <text x={padL - 6} y={padT + chartH + 3} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="9" fontFamily="var(--uni-mono)">
                    {minPnl.toFixed(1)}
                  </text>

                  {/* Lines */}
                  <path d={passivePath} fill="none" stroke="#ff593c" strokeWidth="1.8" strokeDasharray="4,3" strokeLinecap="round" />
                  <path d={arbPath} fill="none" stroke="#00e5b0" strokeWidth="2.2" strokeLinecap="round" />

                  {/* Current step cursor */}
                  {step < n && (
                    <>
                      <circle cx={getMidX(step)} cy={getPnlY(currentPassive)} r="3.5" fill="#ff593c" stroke="#fff" strokeWidth="1" />
                      <circle cx={getMidX(step)} cy={getPnlY(currentArb)} r="4.5" fill="#00e5b0" stroke="#fff" strokeWidth="1.5" />
                    </>
                  )}
                </svg>
              </div>
            </div>

          </div>

          {/* Bottom Live Delta Summary */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.25)', borderRadius: 10, padding: '10px 16px', border: '1px solid rgba(255,255,255,0.05)', marginTop: 4 }}>
            <span style={{ fontSize: 12.5, color: 'var(--uni-neutral2)' }}>
            Current Scenario: <strong>{currentMeta.title}</strong> · {currentMeta.desc}
            </span>
            <div className="mono" style={{ fontSize: 12, color: alphaDelta >= 0 ? '#00e5b0' : '#ff593c', whiteSpace: 'nowrap' }}>
              LP Advantage: <strong>{alphaDelta >= 0 ? '+' : ''}{alphaDelta.toFixed(3)} units</strong>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .sim-page-wrapper {
          padding: 36px 20px 80px;
          max-width: 1100px;
          margin: 0 auto;
        }
        .sim-container {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .sim-card {
          background: var(--uni-surface1);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 20px;
          padding: 22px;
        }
        .scenarios-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
          gap: 12px;
        }
        .scenario-btn {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          padding: 12px 14px;
          background: var(--uni-surface2);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .scenario-btn:hover {
          background: var(--uni-surface2-hover);
          border-color: rgba(255, 255, 255, 0.14);
          transform: translateY(-1px);
        }
        .scenario-btn.active {
          background: linear-gradient(145deg, rgba(0, 229, 176, 0.12), rgba(0, 229, 176, 0.04));
          border-color: rgba(0, 229, 176, 0.45);
          box-shadow: 0 4px 16px rgba(0, 229, 176, 0.12);
        }
        .cockpit-card {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .cockpit-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
          padding-bottom: 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .cockpit-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          background: var(--uni-surface2);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: var(--uni-neutral1);
          transition: all 0.15s ease;
        }
        .cockpit-btn:hover {
          background: var(--uni-surface2-hover);
        }
        .cockpit-btn.primary {
          background: var(--uni-accent1);
          color: var(--uni-on-accent);
          border-color: var(--uni-accent1);
        }
        .cockpit-btn.primary:hover {
          background: var(--uni-accent1-hover);
        }
        .event-alert-box {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: 12px;
        }
        .event-alert-box.nominal {
          background: rgba(0, 229, 176, 0.06);
          border: 1px solid rgba(0, 229, 176, 0.2);
        }
        .event-alert-box.alert {
          background: rgba(245, 158, 11, 0.1);
          border: 1px solid rgba(245, 158, 11, 0.35);
          animation: pulse-border 2s infinite ease-in-out;
        }
        @keyframes pulse-border {
          0%, 100% { border-color: rgba(245, 158, 11, 0.35); }
          50% { border-color: rgba(245, 158, 11, 0.7); }
        }
        .sim-charts-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .sim-chart-panel {
          display: flex;
          flex-direction: column;
        }
        @media (max-width: 800px) {
          .sim-charts-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
};

export default SimulatorPage;
