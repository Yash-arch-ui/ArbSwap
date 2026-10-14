import React from 'react';

/**
 * S2-38 Phase 3.4: a claims ledger page that mirrors `docs/CLAIMS.md`. Statuses
 * are copied verbatim from the ledger; negative results and unproven claims are
 * shown as-is (no economic superiority is asserted). Kept in sync by a test that
 * checks the key status strings against the document.
 */
type Status = 'SUPPORTED' | 'SUPPORTED (devnet only)' | 'SUPPORTED (measurement)' | 'SIMULATION ONLY — UNPROVEN' | 'NOT CLAIMED';

const ROWS: { id: string; claim: string; status: Status; limit: string }[] = [
  { id: '1', claim: 'Honest execution: executed output >= quoted', status: 'SUPPORTED', limit: 'on-chain min_out/min_version; no live devnet proof of a user swap' },
  { id: '6', claim: 'Two-sided quoting (bid + ask)', status: 'SUPPORTED', limit: 'the keeper emits both sides; on-chain stores both' },
  { id: '7', claim: 'Automatic realized-loss breaker', status: 'SUPPORTED', limit: 'detects keeper mis-anchoring against the stored oracle; does NOT detect oracle-lag losses' },
  { id: '8', claim: 'Update/swap compute units', status: 'SUPPORTED (measurement)', limit: 'update_quote median > 40,000 CU on the demo host: the <=40k target is NOT met; host-sensitive' },
  { id: '11', claim: 'Devnet deployment + full money path', status: 'SUPPORTED (devnet only)', limit: 'devnet only; no real funds' },
  { id: '12', claim: 'Live keeper on devnet', status: 'SUPPORTED (devnet only)', limit: 'low cadence, single allowlisted keeper; intermittent freshness (see S2-38)' },
  { id: '10', claim: 'LVR reduction / positive markout (the P1 value claim)', status: 'SIMULATION ONLY — UNPROVEN', limit: 'model output; Option 1 not shown; not to be headlined' },
  { id: '17', claim: '"Beats passive pools" (Option 1)', status: 'NOT CLAIMED', limit: 'T-A not shown' },
  { id: '18', claim: 'Competitiveness vs tight propAMMs', status: 'NOT CLAIMED', limit: '0.0-0.7% routed share vs a propAMM-like model; the venue is a model, not a measured competitor' },
  { id: '13', claim: 'Independent audit', status: 'NOT CLAIMED', limit: 'same-agent self-review only' },
];

const tone = (s: Status): string =>
  s === 'NOT CLAIMED' || s.startsWith('SIMULATION') ? 'var(--uni-warning)' : 'var(--uni-accent1)';

export const ClaimsPage: React.FC = () => (
  <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
    <h1 className="uni-headline">Claims ledger</h1>
    <p className="uni-subheadline">
      Mirrors <span className="mono">docs/CLAIMS.md</span>. Statuses are copied verbatim; unproven and negative results are shown, not hidden.
    </p>
    <div className="uni-card">
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--uni-neutral2)' }}>
            <th>#</th><th>Claim</th><th>Status</th><th>Limit</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--uni-surface3)' }}>
              <td className="mono" style={{ padding: '6px 8px' }}>{r.id}</td>
              <td style={{ padding: '6px 8px' }}>{r.claim}</td>
              <td className="mono" style={{ padding: '6px 8px', color: tone(r.status) }}>{r.status}</td>
              <td style={{ padding: '6px 8px', color: 'var(--uni-neutral2)' }}>{r.limit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="uni-card" style={{ borderColor: 'var(--uni-warning)' }} data-testid="claims-limits">
      <p style={{ fontSize: 13, lineHeight: 1.7 }}>
        Thesis status: <strong>Option 1 (LVR reduction) not shown</strong>; Option 3 never claimed.
        The quoted-vs-fill gap is ~0 by construction. No economic superiority is claimed, and simulated
        attack outcomes are kept separate from on-chain observations.
      </p>
    </div>
  </div>
);
