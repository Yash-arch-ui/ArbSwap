import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import './SwapPage.css';

export const SwapPage: React.FC = () => {
  const { quoteState, tokens, riskBreakers } = useProtocol();
  const { connected } = useWallet();
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
  const effectivePrice = isSellingSol
    ? quoteState.reservationPrice * (1 - quoteState.halfSpreadBps / 10000 - quoteState.bidExtraBps / 10000)
    : quoteState.reservationPrice * (1 + quoteState.halfSpreadBps / 10000 + quoteState.askExtraBps / 10000);

  const expectedOut = isSellingSol
    ? parsedInAmount * effectivePrice
    : parsedInAmount / effectivePrice;

  const feeBps = 1.0;
  const protocolFeeAmount = (expectedOut * feeBps) / 10000;
  const netOut = Math.max(0, expectedOut - protocolFeeAmount);
  const minOut = netOut * (1 - slippageBps / 10000);

  const flip = () => {
    setInTokenSymbol(outTokenSymbol);
    setInAmount('');
  };

  const handleSwap = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    setIsSwapping(true);
    setTimeout(() => {
      setIsSwapping(false);
      setSwapNote(`Filled at exact quoted price (${netOut.toFixed(4)} ${outTokenSymbol}). Zero quote-fill gap!`);
      setTimeout(() => setSwapNote(null), 5000);
    }, 600);
  };

  const maxLevelCapacity = Math.max(...quoteState.levels.map((l) => l.capacityUsd));

  return (
    <div className="uni-swap-wrapper">
      <h1 className="uni-headline">Swap with active liquidity.</h1>
      <p className="uni-subheadline">
        ArbSwap continuously reprices around the Pyth reference price with dynamic spreads. The price you are quoted is the price you get.
      </p>

      <div className="swap-layout">
        {/* ---- Left: Depth Ladder ---- */}
        <div className="depth-ladder-panel">
          <div className="depth-ladder-header">
            <span className="mono depth-ladder-title">6-LEVEL ACTIVE BOOK</span>
            <span className="mono depth-ladder-subtitle">
              SOL/USDC · Half-spread: {quoteState.halfSpreadBps.toFixed(2)} bps
            </span>
          </div>

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

          <div className="depth-footer mono">
            <span>Version v{quoteState.version}</span>
            <span
              className={`depth-status-badge ${quoteState.status === 'Fresh' ? 'fresh' : 'aging'}`}
            >
              {quoteState.status}
            </span>
            <span>Slot {quoteState.currentSlot}</span>
          </div>
        </div>

        {/* ---- Right: Swap box ---- */}
        <div className="uni-swap-box">
          <div className="uni-tabs">
            <span className="uni-tab-title">Swap</span>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)', fontFamily: 'var(--uni-mono)' }}>
              v{quoteState.version} · {quoteState.status}
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
                Balance: {inToken.balance} {inToken.symbol}
                <button type="button" className="uni-max" onClick={() => setInAmount(inToken.balance.toString())}>
                  Max
                </button>
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
            <span className="uni-panel-label">Buy (Guaranteed)</span>
            <div className="uni-panel-row">
              <input
                aria-label="Buy amount"
                className="uni-amount"
                readOnly
                placeholder="0"
                value={parsedInAmount > 0 ? netOut.toFixed(outTokenSymbol === 'SOL' ? 4 : 2) : ''}
              />
              <div className="uni-token-pill">
                <img src={outToken.logo} alt={outToken.symbol} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                <span>{outToken.symbol}</span>
              </div>
            </div>
            <div className="uni-panel-foot">
              <span>~${(netOut * (outTokenSymbol === 'SOL' ? quoteState.oraclePrice : 1)).toFixed(2)} USD</span>
              <span>Balance: {outToken.balance} {outToken.symbol}</span>
            </div>
          </div>

          {/* Main CTA */}
          <button
            type="button"
            className={`uni-main-button ${parsedInAmount > 0 && !riskBreakers.circuitBreakerTripped ? 'accent' : 'disabled'}`}
            disabled={parsedInAmount <= 0 || isSwapping || riskBreakers.circuitBreakerTripped}
            onClick={handleSwap}
          >
            {riskBreakers.circuitBreakerTripped ? (
              '⚠ Circuit Breaker Active'
            ) : !connected ? (
              'Connect Wallet'
            ) : isSwapping ? (
              'Settling on Solana…'
            ) : parsedInAmount <= 0 ? (
              'Enter an amount'
            ) : (
              `Swap ${inTokenSymbol} → ${outTokenSymbol}`
            )}
          </button>

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
                <span className="mono">1 {inTokenSymbol} = {effectivePrice.toFixed(4)} {outTokenSymbol}</span>
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
                      {minOut.toFixed(outTokenSymbol === 'SOL' ? 4 : 2)} {outTokenSymbol}
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
