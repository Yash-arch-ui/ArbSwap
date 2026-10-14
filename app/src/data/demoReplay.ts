// S2-37/5.1: deterministic, offline demo replay. Pure (no network, no wallet, no
// transactions). Same `(seed, scenario)` always yields identical frames.
export type Scenario =
  | 'calm' | 'trend' | 'crash' | 'jump'
  | 'freeze' | 'kill' | 'bot' | 'malicious';

export const SCENARIOS: { id: Scenario; label: string; caption: string }[] = [
  { id: 'calm', label: 'Calm', caption: 'Low-volatility flow; ArbSwap earns the half-spread, passive pool bleeds LVR.' },
  { id: 'trend', label: 'Trend', caption: 'Directional drift; inventory skew widens one side.' },
  { id: 'crash', label: 'Crash', caption: 'Fast adverse move; the per-window flow cap and breaker matter.' },
  { id: 'jump', label: 'Jump', caption: 'A single large jump; the anchor-step guard rejects an over-large remint.' },
  { id: 'freeze', label: 'Attack: freeze oracle', caption: 'Oracle publish time stalls; a stale reference increases exposure.' },
  { id: 'kill', label: 'Attack: kill keeper', caption: 'No new commits; the quote expires and swaps are rejected.' },
  { id: 'bot', label: 'Attack: arbitrage bot', caption: 'An arbitrageur picks off a mispriced side until the flow cap binds.' },
  { id: 'malicious', label: 'Attack: malicious keeper', caption: 'Keeper anchors at the max deviation; the edge breaker trips.' },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Frame {
  t: number; mid: number; arbSwap: number; passive: number; event?: string;
}

/** Deterministic frames; `n` steps; notional units, no funds involved. */
export function generateFrames(seed: number, scenario: Scenario, n = 240): Frame[] {
  const rnd = mulberry32(seed);
  const frames: Frame[] = [];
  let mid = 107;
  let arb = 0;
  let passive = 0;
  let frozen = scenario === 'freeze';
  let killed = scenario === 'kill';
  for (let t = 0; t < n; t += 1) {
    const shock = (rnd() - 0.5) * 0.4;
    switch (scenario) {
      case 'trend': mid *= 1 + 0.0015 + shock * 0.001; break;
      case 'crash': mid *= t > n * 0.4 ? 0.994 : 1 + shock * 0.001; break;
      case 'jump': if (t === Math.floor(n * 0.5)) mid *= scenario === 'jump' ? 1.15 : 1; mid *= 1 + shock * 0.0005; break;
      case 'freeze': frozen = t > n * 0.3; mid *= 1 + shock * 0.0002; break;
      case 'kill': killed = t > n * 0.2; mid *= 1 + shock * 0.0005; break;
      case 'bot': mid *= 1 + (t > n * 0.3 ? 0.0008 : 0) + shock * 0.0006; break;
      case 'malicious': mid *= 1 + 0.0004 + shock * 0.001; break;
      default: mid *= 1 + shock * 0.0006;
    }
    // ArbSwap earns spread on flow but loses to adverse selection / attacks.
    const spread = 0.0009;
    const adverse = scenario === 'bot' ? 0.0016 : scenario === 'malicious' ? 0.0014 : 0.0007;
    const active = !killed && !frozen;
    arb += active ? (spread - adverse) * mid * 0.1 : 0;
    passive += -adverse * 1.4 * mid * 0.1;
    let event: string | undefined;
    if (scenario === 'freeze' && t === n * 0.3) event = 'oracle frozen';
    if (scenario === 'kill' && t === n * 0.2) event = 'keeper killed — quotes expire';
    if (scenario === 'malicious' && t === n * 0.6) event = 'breaker trips';
    if (scenario === 'bot' && t === n * 0.7) event = 'flow cap binds';
    frames.push({ t, mid, arbSwap: arb, passive, event });
  }
  return frames;
}
