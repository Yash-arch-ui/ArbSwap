import React, { useEffect, useMemo, useState } from 'react';
import streams from '../data/demoStreams.json';

/**
 * S2-38 Phase 3: deterministic, offline demo. The frames come from the generated
 * bundle (`app/src/data/demoStreams.json`, produced by
 * `simulation.attackers.export_streams`) imported at build time — so the page
 * makes **no runtime network call, no wallet connection and no transaction**.
 * Attack/scenario outcomes are labelled as simulation, not on-chain data.
 */
interface ScenarioStream { mid: number[]; arbSwap: number[]; passive: number[]; events: Record<string, string>; }
const STREAMS = (streams as { meta: { label: string; seed: number }; streams: Record<string, ScenarioStream> });
const CAPTIONS: Record<string, string> = {
  calm: 'Low-volatility flow; ArbSwap earns the half-spread, the passive pool bleeds LVR.',
  trend: 'Directional drift; inventory skew widens one side.',
  crash: 'Fast adverse move; the per-window flow cap and breaker matter.',
  jump: 'A single large jump; the anchor-step guard rejects an over-large remint.',
  freeze: 'Attack: oracle publish time stalls; a stale reference increases exposure.',
  kill: 'Attack: no new commits; the quote expires and swaps are rejected.',
  bot: 'Attack: an arbitrageur picks off a mispriced side until the flow cap binds.',
  malicious: 'Attack: keeper anchors at the max deviation; the edge breaker trips.',
};

export const DemoPage: React.FC = () => {
  const ids = useMemo(() => Object.keys(STREAMS.streams), []);
  const [scenario, setScenario] = useState(ids[0] ?? 'calm');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const data = STREAMS.streams[scenario] ?? STREAMS.streams[ids[0]];
  const n = data.mid.length;

  useEffect(() => { setStep(0); }, [scenario]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1) % n), 200 / speed);
    return () => clearInterval(id);
  }, [playing, speed, n]);

  const W = 640; const H = 160;
  const px = (i: number) => (i / Math.max(1, n - 1)) * W;
  const scale = (vals: number[]) => {
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    return (v: number) => H - ((v - mn) / Math.max(1e-9, mx - mn)) * H;
  };
  const pyMid = scale(data.mid);
  const pyPnl = scale([...data.arbSwap, ...data.passive]);
  const upto = <T,>(a: T[]) => a.slice(0, step + 1);
  const path = (a: number[], y: (v: number) => number) => upto(a).map((v, i) => `${px(i)},${y(v)}`).join(' ');
  const event = data.events[String(step)];

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="uni-headline">Deterministic demo replay</h1>
      <p className="uni-subheadline">
        Seeded, offline simulation — <strong>{STREAMS.meta.label}</strong> (seed {STREAMS.meta.seed}).
        No network calls, no wallet, no transactions. Not on-chain data.
      </p>
      <div className="uni-card" data-testid="demo-scenarios" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {ids.map((id) => (
          <button key={id} type="button"
            className={`uni-button ${scenario === id ? 'uni-button-accent' : 'uni-button-ghost'}`}
            onClick={() => setScenario(id)}>{id}</button>
        ))}
      </div>
      <div className="uni-card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <button type="button" className="uni-button uni-button-ghost" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
          <label className="mono" style={{ fontSize: 12 }}>speed
            <input type="range" min={1} max={4} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            {speed}x
          </label>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>t={step}/{n - 1}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="mid price">
          <polyline fill="none" stroke="var(--uni-accent1)" strokeWidth="1.5" points={path(data.mid, pyMid)} />
        </svg>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="pnl">
          <polyline fill="none" stroke="#5b8cff" strokeWidth="1.5" points={path(data.arbSwap, pyPnl)} />
          <polyline fill="none" stroke="#b06" strokeWidth="1.5" points={path(data.passive, pyPnl)} />
        </svg>
        <p style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>{CAPTIONS[scenario] ?? ''}</p>
        {event && <p className="mono" style={{ fontSize: 12, color: 'var(--uni-warning)' }}>event: {event}</p>}
        <p className="mono" style={{ fontSize: 12 }}>
          ArbSwap PnL {data.arbSwap[step]?.toFixed(3)} · passive pool {data.passive[step]?.toFixed(3)} (units, simulated)
        </p>
      </div>
    </div>
  );
};
