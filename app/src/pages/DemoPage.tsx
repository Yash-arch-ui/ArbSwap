import React, { useEffect, useMemo, useState } from 'react';
import { generateFrames, SCENARIOS, type Scenario } from '../data/demoReplay';

/**
 * S2-37/5.1: deterministic, offline replay. No network, no wallet, no
 * transactions — `generateFrames` is pure and seeded, so the same scenario always
 * renders identical frames.
 */
export const DemoPage: React.FC = () => {
  const [scenario, setScenario] = useState<Scenario>('calm');
  const [seed, setSeed] = useState(42);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const frames = useMemo(() => generateFrames(seed, scenario, 240), [seed, scenario]);
  const caption = SCENARIOS.find((s) => s.id === scenario)?.caption ?? '';

  useEffect(() => { setStep(0); }, [scenario, seed]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1) % frames.length), 200 / speed);
    return () => clearInterval(id);
  }, [playing, speed, frames.length]);

  const visible = frames.slice(0, step + 1);
  const W = 640; const H = 180;
  const prices = frames.map((f) => f.mid);
  const pmin = Math.min(...prices); const pmax = Math.max(...prices);
  const px = (i: number) => (i / (frames.length - 1)) * W;
  const py = (v: number) => H - ((v - pmin) / Math.max(1e-9, pmax - pmin)) * H;
  const pnl = frames.map((f) => f.arbSwap);
  const nmin = Math.min(...pnl); const nmax = Math.max(...pnl);
  const ny = (v: number) => H - ((v - nmin) / Math.max(1e-9, nmax - nmin)) * H;

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="uni-headline">Deterministic demo replay</h1>
      <p className="uni-subheadline">
        Seeded, offline simulation — <strong>simulation, no funds involved</strong>. No network calls, no wallet, no transactions.
      </p>
      <div className="uni-card" data-testid="demo-scenarios" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {SCENARIOS.map((s) => (
          <button key={s.id} type="button"
            className={`uni-button ${scenario === s.id ? 'uni-button-accent' : 'uni-button-ghost'}`}
            onClick={() => setScenario(s.id)}>{s.label}</button>
        ))}
      </div>
      <div className="uni-card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <button type="button" className="uni-button uni-button-ghost" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
          <label className="mono" style={{ fontSize: 12 }}>speed
            <input type="range" min={1} max={4} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            {speed}x
          </label>
          <label className="mono" style={{ fontSize: 12 }}>seed
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} style={{ width: 80 }} />
          </label>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>t={step}/{frames.length - 1}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="mid price">
          <polyline fill="none" stroke="var(--uni-accent1)" strokeWidth="1.5" points={visible.map((f, i) => `${px(i)},${py(f.mid)}`).join(' ')} />
        </svg>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="pnl">
          <polyline fill="none" stroke="#5b8cff" strokeWidth="1.5" points={visible.map((f, i) => `${px(i)},${ny(f.arbSwap)}`).join(' ')} />
          <polyline fill="none" stroke="#b06" strokeWidth="1.5" points={visible.map((f, i) => `${px(i)},${ny(f.passive)}`).join(' ')} />
        </svg>
        <p style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>{caption}</p>
        {visible.at(-1)?.event && <p className="mono" style={{ fontSize: 12, color: 'var(--uni-warning)' }}>event: {visible.at(-1)!.event}</p>}
        <p className="mono" style={{ fontSize: 12 }}>
          ArbSwap PnL {visible.at(-1)?.arbSwap.toFixed(3)} · passive pool {visible.at(-1)?.passive.toFixed(3)} (units)
        </p>
      </div>
    </div>
  );
};
