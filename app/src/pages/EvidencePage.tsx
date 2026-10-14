import React from 'react';
import { ARBSWAP_PROGRAM_ID, ACTIVE_VAULT, explorerTxUrl, explorerAddressUrl } from '../chain/config';

/**
 * S2-37/5.2: recorded Devnet history (real signatures/accounts) with explorer
 * links, labelled "devnet history", plus the honest demo-configuration limits.
 * Read-only; renders no live data and makes no network calls.
 */
const TX: { label: string; sig: string; note: string }[] = [
  {
    label: 'Program upgrade (S2-37: tunable expiry_slots)',
    sig: '31Aa7GZXKyFzzVNnFE2xfdqhuohdEtuYvE5bJKoixpZ9uMpW77uhpLAaFdCiH17RMB4ReEZpWwWw1Byma6Bqyb7f',
    note: 'slot 510905181',
  },
  {
    label: 'set_params proposal (expiry_slots 10 -> 120; timelocked)',
    sig: '5rDWeiunvT2nibghefnjZrEKUAwgCb5pPcXSAh68dag5FMjtT8FbU7MGgSJY2JV3AyfBqa4eH2cBqNYmPqu9mec4',
    note: 'slot 510911388, activates slot 511127388',
  },
];

const PREFIXED: { label: string; prefix: string }[] = [
  { label: 'Initial deposit', prefix: 'N6XoMGrp…' },
  { label: 'BuyBase swap', prefix: '51TkKqfi…' },
  { label: 'QuoteState migration', prefix: 'qmTocoCx…' },
  { label: 'Staged-quote commits', prefix: '5HLsz3DW…, 3RdDLi5s…, yTk9ZWPc…' },
];

export const EvidencePage: React.FC = () => (
  <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
    <h1 className="uni-headline">Devnet history &amp; evidence</h1>
    <p className="uni-subheadline">Recorded Solana Devnet history with explorer links. Everything on this page is <strong>devnet history</strong>.</p>

    <div className="uni-card">
      <h3 style={{ fontSize: 15 }}>Canonical addresses</h3>
      <ul className="mono" style={{ fontSize: 12, lineHeight: 1.9 }}>
        <li>Program: <a href={explorerAddressUrl(ARBSWAP_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">{ARBSWAP_PROGRAM_ID.toBase58()}</a></li>
        <li>Vault: <a href={explorerAddressUrl(ACTIVE_VAULT.vault.toBase58())} target="_blank" rel="noreferrer">{ACTIVE_VAULT.vault.toBase58()}</a></li>
        <li>Base mint (WSOL): {ACTIVE_VAULT.baseMint.toBase58()} · Quote mint (USDC): {ACTIVE_VAULT.quoteMint.toBase58()}</li>
      </ul>
    </div>

    <div className="uni-card" data-testid="evidence-txs">
      <h3 style={{ fontSize: 15 }}>Recorded transactions</h3>
      <ul style={{ fontSize: 13, lineHeight: 1.9 }}>
        {TX.map((t) => (
          <li key={t.sig}>
            {t.label} — <a href={explorerTxUrl(t.sig)} target="_blank" rel="noreferrer" className="mono">{t.sig.slice(0, 8)}…{t.sig.slice(-6)}</a> ({t.note})
          </li>
        ))}
      </ul>
      <p className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>
        Also recorded (prefixes): {PREFIXED.map((p) => `${p.label} ${p.prefix}`).join(' · ')}
      </p>
    </div>

    <div className="uni-card" style={{ borderColor: 'var(--uni-warning)' }}>
      <h3 style={{ fontSize: 15 }}>Limits (devnet demo configuration)</h3>
      <p style={{ fontSize: 13, lineHeight: 1.7 }}>
        Planned (pending the timelocked apply): quotes remain valid for 120 slots (~30 s) so a person can swap;
        the oracle must still be within 2 s at quote commit, but the swap does not re-check oracle age, so a longer
        validity increases exposure to stale-price fills; test funds only; the realized-edge breaker and the
        per-window flow cap remain active. This is a demo configuration, not a guarantee. Option 1 (LVR reduction)
        is not shown as demonstrated; routed volume share against a tight propAMM-like venue is near zero.
      </p>
    </div>
  </div>
);
