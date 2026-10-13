import React, { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import { swap as swapOnChain } from '../chain/program';
import { parseUnits, formatUnits } from '../chain/amounts';
import { swapAmounts, type SwapSideName } from '../chain/swapMath';
import { swapUnavailableReason } from '../chain/gating';
import './SwapPage.css';

export const SwapPage: React.FC = () => {
  const { quoteState, tokens, riskBreakers, refreshBalances, vaultInitialized, quoteAvailable, liveError } = useProtocol();
  const { connection } = useConnection();
  const { connected, publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [inTokenSymbol, setInTokenSymbol] = useState<'SOL' | 'USDC'>('SOL');
  const [inAmount, setInAmount] = useState<string>('1.0');
  const [slippageBps] = useState<number>(10); // 0.10%
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [isSwapping, setIsSwapping] = useState<boolean>(false);
  const [swapNote, setSwapNote] = useState<string | null>(null);

  const outTokenSymbol = inTokenSymbol === 'SOL' ? 'USDC' : 'SOL';
  const inToken = tokens[inTokenSymbol];
  const outToken = tokens[outTokenSymbol];
  const parsedInAmount = parseFloat(inAmount) || 0;

  const isSellingSol = inTokenSymbol === 'SOL';
  const side: SwapSideName = isSellingSol ? 'sellBase' : 'buyBase';
  const feeBps = 1;

  // Integer amount plan derived from the on-chain reservation sqrt price (no
  // floating point in the transaction path). `expectedOutAtoms` is a
  // reservation-price floor, NOT a full ladder simulation; the deployed program
  // enforces `out >= min_out`. When there is no quote, `pResSqrt` is "0" and the
  // estimate is 0 (and submission is disabled anyway).
  const pResSqrtQ64 = (() => {
    try {
      return BigInt(quoteState.pResSqrt || '0');
    } catch {
      return 0n;
    }
  })();
  const amountInAtoms = (() => {
    try {
      return parseUnits(inAmount || '0', inToken.decimals);
    } catch {
      return 0n;
    }
  })();
  const amounts = swapAmounts({ side, amountInAtoms, feeBps, slippageBps, pResSqrtQ64 });
  const expectedOutHuman = formatUnits(amounts.expectedOut, outToken.decimals, 6);
  const minOutHuman = formatUnits(amounts.minOut, outToken.decimals, 6);

  // Fail closed: swaps require a fresh on-chain quote.
  const swapBlockedReason = swapUnavailableReason({
    vaultInitialized,
    circuitBreakerTripped: riskBreakers.circuitBreakerTripped,
    quoteAvailable,
  });

  const flip = () => {
    setInTokenSymbol(outTokenSymbol);
    setInAmount('');
  };

  const handleSwap = async () => {
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    if (swapBlockedReason) {
      setSwapNote(swapBlockedReason);
      return;
    }
    setIsSwapping(true);
    setSwapNote(null);
    try {
      // SOL in = trader sells base; USDC in = trader buys base.
      const ixSide = isSellingSol ? { sellBase: {} } : { buyBase: {} };
      const signature = await swapOnChain(
        connection,
        wallet,
        ixSide as never,
        amountInAtoms,
        amounts.minOut,
        BigInt(quoteState.version),
      );
      setSwapNote(
        `Swap confirmed ${signature.slice(0, 8)}… — minimum received enforced on-chain (${minOutHuman} ${outTokenSymbol}).`,
      );
      await refreshBalances();
    } catch (error) {
      setSwapNote(`Swap failed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}`);
    } finally {
      setIsSwapping(false);
    }
  };

  // Guard against divide-by-zero when no quote is available (never render NaN bars).
  const maxLevelCapacity = Math.max(1, ...quoteState.levels.map((l) => l.capacityUsd));

  return (
    <div className="uni-swap-wrapper">
      <h1 className="uni-headline">Swap with active liquidity.</h1>
      <p className="uni-subheadline">
        ArbSwap continuously reprices around the Pyth reference price with dynamic spreads.
      </p>

      {!vaultInitialized && (
        <div className="uni-card" style={{ marginBottom: 12 }}>
          <strong>Vault not initialized.</strong> No on-chain vault was read for the
          configured WSOL/USDC vault, so swaps are disabled and no live price is shown.
        </div>
      )}

      {liveError && (
        <div className="uni-card" style={{ marginBottom: 12, borderColor: 'var(--uni-warning)' }} role="alert">
          <strong>Chain read error:</strong> {liveError}. Last known values are
          retained; the app retries every 4&nbsp;s.
        </div>
      )}

      {quoteState.hasQuote && quoteState.status !== 'Fresh' && (
        <div className="uni-card" style={{ marginBottom: 12 }} role="status">
          <strong>Quote {quoteState.status.toLowerCase()}.</strong>{' '}
          Version v{quoteState.version}, expiry slot {quoteState.expirySlot} (current slot{' '}
          {quoteState.currentSlot}). Swaps stay disabled until the keeper commits a new
          staged quote.
        </div>
      )}

      <div className="swap-layout">
        {/* ---- Left: Depth Ladder ---- */}
        <div className="depth-ladder-panel">
          <div className="depth-ladder-header">
            <span className="mono depth-ladder-title">6-LEVEL ACTIVE BOOK</span>
            <span className="mono depth-ladder-subtitle">
              SOL/USDC · {quoteState.hasQuote
                ? `Half-spread: ${quoteState.halfSpreadBps.toFixed(2)} bps`
                : 'Half-spread: unavailable'}
            </span>
          </div>

          {!quoteState.hasQuote ? (
            <div className="depth-unavailable" role="status" aria-live="polite">
              <strong>Quote unavailable</strong>
              <p className="mono">
                No committed on-chain quote was read for this vault, so no
                price, spread, or depth is shown. The keeper must publish a fresh
                staged quote (Pyth push + <code>commit_quote</code>) before this
                book can display real values.
              </p>
            </div>
          ) : (
            <>
              <div className="depth-cols">
                <div className="depth-col-label mono">Size (USD)</div>
                <div className="depth-col-label mono" style={{ textAlign: 'center' }}>Level</div>
                <div className="depth-col-label mono" style={{ textAlign: 'right' }}>Price</div>
              </div>

              {/* Asks (reversed so lowest ask is closest to mid) */}
              {[...quoteState.levels].reverse().map((lvl) => (
                <div key={`ask-${lvl.level}`} className="depth-row ask-row">
                  <div className="depth-bar-wrap ask-side">
                    <div
                      className="depth-bar ask-bar"
                      style={{ width: `${(lvl.capacityUsd / maxLevelCapacity) * 100}%` }}
                    />
                  </div>
                  <span className="depth-row-size mono">${(lvl.capacityUsd / 1000).toFixed(0)}k</span>
                  <span className="depth-row-level mono">L{lvl.level}</span>
                  <span className="depth-row-price mono ask-price">${lvl.askPrice.toFixed(3)}</span>
                </div>
              ))}

              {/* Mid anchor */}
              <div className="depth-mid-row">
                <span className="mono depth-mid-label">Pyth Mid</span>
                <span className="mono depth-mid-price">${quoteState.oraclePrice.toFixed(2)}</span>
                <span className="mono depth-mid-spread">±{quoteState.halfSpreadBps.toFixed(1)} bps</span>
              </div>

              {/* Bids */}
              {quoteState.levels.map((lvl) => (
                <div key={`bid-${lvl.level}`} className="depth-row bid-row">
                  <div className="depth-bar-wrap bid-side">
                    <div
                      className="depth-bar bid-bar"
                      style={{ width: `${(lvl.capacityUsd / maxLevelCapacity) * 100}%` }}
                    />
                  </div>
                  <span className="depth-row-size mono">${(lvl.capacityUsd / 1000).toFixed(0)}k</span>
                  <span className="depth-row-level mono">L{lvl.level}</span>
                  <span className="depth-row-price mono bid-price">${lvl.bidPrice.toFixed(3)}</span>
                </div>
              ))}
            </>
          )}

          <div className="depth-footer mono">
            <span>Version {quoteState.hasQuote ? `v${quoteState.version}` : '—'}</span>
            <span
              className={`depth-status-badge ${quoteState.status === 'Fresh' ? 'fresh' : quoteState.status === 'Unavailable' ? 'unavailable' : 'aging'}`}
            >
              {quoteState.status}
            </span>
            <span>Slot {quoteState.currentSlot}</span>
            {quoteState.hasQuote && (
              <>
                <span>exp {quoteState.expirySlot}</span>
                <span>oracle {quoteState.oraclePublishTime}</span>
                <span>
                  author {quoteState.quoteKeeper
                    ? `${quoteState.quoteKeeper.slice(0, 4)}…${quoteState.quoteKeeper.slice(-4)}`
                    : 'unattributed'}
                </span>
              </>
            )}
          </div>
        </div>

        {/* ---- Right: Swap box ---- */}
        <div className="uni-swap-box">
          <div className="uni-tabs">
            <span className="uni-tab-title">Swap</span>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)', fontFamily: 'var(--uni-mono)' }}>
              {quoteState.hasQuote ? `v${quoteState.version} · ${quoteState.status}` : 'quote unavailable'}
            </span>
          </div>

          <div className="uni-panel-foot" style={{ justifyContent: 'flex-end', paddingTop: 0 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--uni-neutral2)' }}>
              {connected && publicKey
                ? `Wallet ${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
                : 'Wallet not connected'}
            </span>
          </div>

          {/* Sell Panel */}
          <div className="uni-panel uni-panel-sell">
            <span className="uni-panel-label">Sell</span>
            <div className="uni-panel-row">
              <input
                aria-label="Sell amount"
                className="uni-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={inAmount}
                onChange={(e) => {
                  const next = e.target.value.replace(',', '.');
                  if (/^\d*\.?\d*$/.test(next)) setInAmount(next);
                }}
              />
              <div className="uni-token-pill">
                <img src={inToken.logo} alt={inToken.symbol} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                <span>{inToken.symbol}</span>
              </div>
            </div>
            <div className="uni-panel-foot">
              <span>~${(parsedInAmount * (inTokenSymbol === 'SOL' ? quoteState.oraclePrice : 1)).toFixed(2)} USD</span>
              <span>
                Balance: {connected ? `${inToken.balance} ${inToken.symbol}` : 'connect wallet'}
                {connected && (
                  <button type="button" className="uni-max" onClick={() => setInAmount(inToken.balance.toString())}>
                    Max
                  </button>
                )}
              </span>
            </div>
          </div>

          {/* Flip Button */}
          <button type="button" className="uni-flip" aria-label="Switch tokens" onClick={flip}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4" />
            </svg>
          </button>

          {/* Buy Panel */}
          <div className="uni-panel uni-panel-buy">
            <span className="uni-panel-label">Buy (at quoted price)</span>
            <div className="uni-panel-row">
              <input
                aria-label="Buy amount"
                className="uni-amount"
                readOnly
                placeholder="0"
                value={parsedInAmount > 0 ? expectedOutHuman : ''}
              />
              <div className="uni-token-pill">
                <img src={outToken.logo} alt={outToken.symbol} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                <span>{outToken.symbol}</span>
              </div>
            </div>
            <div className="uni-panel-foot">
              <span>~${(Number(expectedOutHuman) * (outTokenSymbol === 'SOL' ? quoteState.oraclePrice : 1)).toFixed(2)} USD (estimate)</span>
              <span>Balance: {connected ? `${outToken.balance} ${outToken.symbol}` : 'connect wallet'}</span>
            </div>
          </div>

          {/* Main CTA */}
          <button
            type="button"
            className={`uni-main-button ${parsedInAmount > 0 && !swapBlockedReason && connected ? 'accent' : 'disabled'}`}
            disabled={parsedInAmount <= 0 || isSwapping || (connected && !!swapBlockedReason)}
            onClick={handleSwap}
          >
            {!connected ? (
              'Connect Wallet'
            ) : swapBlockedReason ? (
              'Swaps unavailable'
            ) : isSwapping ? (
              'Settling on Solana…'
            ) : parsedInAmount <= 0 ? (
              'Enter an amount'
            ) : (
              `Swap ${inTokenSymbol} → ${outTokenSymbol}`
            )}
          </button>

          {connected && swapBlockedReason && (
            <p className="swap-success-note" style={{ color: 'var(--uni-warning)' }}>
              {swapBlockedReason}
            </p>
          )}

          {swapNote && (
            <p className="swap-success-note">✓ {swapNote}</p>
          )}

          {/* Details toggle */}
          {parsedInAmount > 0 && (
            <div className="uni-details">
              <button
                type="button"
                className="uni-details-toggle"
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <span className="mono">Est. out ≈ {expectedOutHuman} {outTokenSymbol} (reservation-price floor)</span>
                <span style={{ color: 'var(--uni-neutral2)', fontSize: 12 }}>
                  Fee: 1.0 bps {detailsOpen ? '▲' : '▼'}
                </span>
              </button>

              {detailsOpen && (
                <dl className="uni-details-body uni-card" style={{ marginTop: 6, padding: '14px 16px' }}>
                  <div><dt>Pyth Oracle Reference</dt><dd>${quoteState.oraclePrice.toFixed(2)}</dd></div>
                  <div><dt>Reservation Price (P_res)</dt><dd>${quoteState.reservationPrice.toFixed(2)}</dd></div>
                  <div><dt>Dynamic Half-Spread</dt><dd>{quoteState.halfSpreadBps.toFixed(2)} bps</dd></div>
                  <div>
                    <dt>Min. Received (Protected)</dt>
                    <dd style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>
                      {minOutHuman} {outTokenSymbol}
                    </dd>
                  </div>
                  <div><dt>Order Routing</dt><dd>ArbSwap Engine (Direct On-Chain)</dd></div>
                  <div><dt>Quote Expiry Guard</dt><dd>10 slots (~4.0s)</dd></div>
                </dl>
              )}
            </div>
          )}

          <p className="swap-footer-note">
            Zero quote-versus-fill gap by construction. Swaps revert rather than fill at a worse price.
          </p>
        </div>
      </div>
    </div>
  );
};
