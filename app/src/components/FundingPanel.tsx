import React, { useState } from 'react';
import { ACTIVE_VAULT } from '../chain/config';

/**
 * S2-37/4.3: shown when a connected wallet holds zero of both vault tokens.
 * Links are the canonical Devnet faucets (verified reachable) and the Circle
 * USDC mint; no balance or price is fabricated.
 */
export const FundingPanel: React.FC<{ baseSymbol: string; quoteSymbol: string }> = ({
  baseSymbol,
  quoteSymbol,
}) => {
  const [copied, setCopied] = useState(false);
  const usdcMint = ACTIVE_VAULT.quoteMint.toBase58();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(usdcMint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="uni-card" style={{ marginBottom: 12, borderColor: 'var(--uni-warning)' }} role="status">
      <strong>Fund this Devnet wallet.</strong> It holds no {baseSymbol} or {quoteSymbol} yet.
      <ol style={{ margin: '8px 0 0 18px', fontSize: 13, lineHeight: 1.7 }}>
        <li>
          Get Devnet SOL:{' '}
          <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--uni-accent1)' }}>
            faucet.solana.com
          </a>{' '}
          (then wrap some into {baseSymbol} on the Swap page).
        </li>
        <li>
          Get Devnet USDC:{' '}
          <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--uni-accent1)' }}>
            faucet.circle.com
          </a>{' '}
          — select <span className="mono">Solana Devnet</span> and paste the mint below.
        </li>
        <li>
          {quoteSymbol} mint: <span className="mono">{usdcMint}</span>{' '}
          <button type="button" className="uni-max" onClick={copy}>
            {copied ? 'copied' : 'copy'}
          </button>
        </li>
      </ol>
      <p style={{ fontSize: 12, color: 'var(--uni-neutral2)', margin: '8px 0 0' }}>
        Devnet test funds only — no real value.
      </p>
    </div>
  );
};
