import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { APP_RPC_FAILOVER } from '../chain/rpcFailover';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import { swap as swapOnChain, fetchFreshQuote } from '../chain/program';
import { parseUnits, formatUnits } from '../chain/amounts';
import { swapAmountsFromLadder, type SwapSideName, type LadderLevel } from '../chain/swapMath';
import { liveSwapGateReason, submitFreshnessReason } from '../chain/gating';
import { isTransportError } from '../chain/dataState';
import { ACTIVE_VAULT, TRANSACTIONS_ENABLED, TRANSACTION_DISABLED_REASON } from '../chain/config';
import { ReadOnlyBanner } from '../components/ReadOnlyMode';
import './SwapPage.css';

export const SwapPage: React.FC = () => {
  const {
    quoteState, tokens, riskBreakers, protocolParams,
    refreshBalances, refreshProtocol, retryNow,
    walletAtoms, vaultSource, vaultExists, rpcStatus, balancesSource,
    quoteAvailable, lastUpdatedAt, genesisVerified,
  } = useProtocol();
  const connection = APP_RPC_FAILOVER.connection;
  const { connected, publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [inTokenSymbol, setInTokenSymbol] = useState<'SOL' | 'USDC'>('SOL');
  const [inAmount, setInAmount] = useState<string>('1.0');
  const [slippageBps] = useState<number>(10); // 0.10%
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [isSwapping, setIsSwapping] = useState<boolean>(false);
  // Note carries a severity so the UI never shows a success check on a failure.
  const [swapNote, setSwapNote] = useState<{ text: string; ok: boolean } | null>(null);

  const outTokenSymbol = inTokenSymbol === 'SOL' ? 'USDC' : 'SOL';
  const inToken = tokens[inTokenSymbol];
  const outToken = tokens[outTokenSymbol];
  const parsedInAmount = parseFloat(inAmount) || 0;

  const isSellingSol = inTokenSymbol === 'SOL';
  const side: SwapSideName = isSellingSol ? 'sellBase' : 'buyBase';
  // Live on-chain fee (Config.fee_bps); fall back only for display before load.
  const feeBps = protocolParams?.feeBps ?? 1;

  // Integer amount plan derived from the **committed on-chain ladder** (an exact
  // mirror of `arb_math::walk_ladder`), so `expectedOut` and `minOut` match what
  // the program will enforce. No floating point in the transaction path. When
  // there is no quote the raw levels are empty and the plan is zero (and
  // submission is disabled anyway).
  const ladderLevels: LadderLevel[] = (() => {
    const raw = isSellingSol ? quoteState.bidLevelsRaw : quoteState.askLevelsRaw;
    try {
      return raw.map((l) => ({
        sqrtLo: BigInt(l.sqrtLo),
        sqrtHi: BigInt(l.sqrtHi),
        liquidity: BigInt(l.liquidity),
      }));
    } catch {
      return [];
    }
  })();
  const amountInAtoms = (() => {
    try {
      return parseUnits(inAmount || '0', inToken.decimals);
    } catch {
      return 0n;
    }
  })();
  const amounts = swapAmountsFromLadder({ side, amountInAtoms, feeBps, slippageBps, levels: ladderLevels });
  const expectedOutHuman = formatUnits(amounts.expectedOut, outToken.decimals, 6);
  const minOutHuman = formatUnits(amounts.minOut, outToken.decimals, 6);

  // Fail closed: swaps require a fresh on-chain quote, the committed ladder must
  // be able to absorb the whole input (otherwise the program reverts), and the
  // connected wallet must actually hold enough of the input token. The base mint
  // is WSOL, so selling SOL requires wrapped SOL: we say so explicitly rather
  // than letting the transaction fail on-chain.
  const capacityReason =
    amountInAtoms > 0n && amounts.capacityExceeded
      ? 'Swaps unavailable: the committed ladder cannot fill this size (on-chain capacity cap).'
      : null;
  const balanceReason = (() => {
    if (!connected || amountInAtoms <= 0n) return null;
    if (isSellingSol) {
      if (walletAtoms && walletAtoms.base < amountInAtoms) {
        return `Insufficient wrapped SOL: you hold ${formatUnits(walletAtoms.base, ACTIVE_VAULT.baseDecimals)} WSOL but are selling ${formatUnits(amountInAtoms, ACTIVE_VAULT.baseDecimals)}. Wrap native SOL to WSOL first.`;
      }
    } else if (walletAtoms && walletAtoms.quote < amountInAtoms) {
      return `Insufficient USDC: you hold ${formatUnits(walletAtoms.quote, ACTIVE_VAULT.quoteDecimals)} USDC but are spending ${formatUnits(amountInAtoms, ACTIVE_VAULT.quoteDecimals)}.`;
    }
    return null;
  })();
  const transportError = isTransportError(vaultSource.errorKind);
  const vaultUninitialized = vaultExists === false;
  const rpcRateLimited = vaultSource.errorKind === 'rate_limited';
  const balancesAvailable = balancesSource.state === 'live';
  const priceAvailable = quoteState.hasQuote && quoteState.oraclePrice > 0;
  const stale = vaultSource.state === 'stale';

  const swapBlockedReason =
    balanceReason ??
    capacityReason ??
    liveSwapGateReason({
      vaultState: vaultSource.state,
      vaultExists,
      errorKind: vaultSource.errorKind,
      genesisVerified,
      circuitBreakerTripped: riskBreakers.circuitBreakerTripped,
      quoteAvailable,
      quoteStatus: quoteState.status,
    });
  // S2-35/S2-36: submission is gated by the resolved execution mode (the main
  // agent's `TRANSACTIONS_ENABLED`); the state-aware gate governs the rest.
  const submitBlockedReason = !TRANSACTIONS_ENABLED
    ? (TRANSACTION_DISABLED_REASON ?? 'Transactions are disabled in this build.')
    : swapBlockedReason;

  // A single, state-aware liquidity-book heading (never "ACTIVE" unless fresh).
  const bookHeading = (() => {
    if (rpcRateLimited) return 'RPC RATE LIMITED';
    if (transportError) return 'RPC UNAVAILABLE';
    if (vaultSource.state === 'loading') return 'LOADING BOOK';
    if (vaultUninitialized) return 'VAULT UNINITIALIZED';
    if (vaultSource.state === 'invalid') return 'BOOK INVALID';
    if (!quoteState.hasQuote) return 'QUOTE UNAVAILABLE';
    if (quoteState.status === 'Fresh') return '6-LEVEL ACTIVE BOOK';
    return `LAST-KNOWN BOOK — ${quoteState.status.toUpperCase()}`;
  })();

  // Exactly one primary status message (no duplicated error paragraphs).
  const primaryStatus = (() => {
    if (rpcRateLimited) {
      return {
        tone: 'warning',
        title: 'Devnet RPC is rate-limiting requests (HTTP 429).',
        body: 'Live vault and quote data could not be refreshed. Trading remains unavailable until the data read succeeds.',
      };
    }
    if (transportError) {
      return {
        tone: 'warning',
        title: 'Live data read failed.',
        body: `${vaultSource.reason ?? 'The Devnet read failed.'} Trading remains unavailable until the read succeeds.`,
      };
    }
    if (vaultSource.state === 'invalid') {
      return { tone: 'critical', title: 'Vault account failed validation.', body: vaultSource.reason ?? 'Owner/layout mismatch.' };
    }
    if (vaultUninitialized) {
      return {
        tone: 'neutral',
        title: 'Vault not initialized.',
        body: 'A successful account lookup found no vault for the configured WSOL/USDC mints on Devnet, so swaps are disabled.',
      };
    }
    if (stale) {
      return {
        tone: 'warning',
        title: 'Showing last-known data (stale).',
        body: vaultSource.reason ?? 'The latest refresh failed; values are not fresh.',
      };
    }
    if (quoteState.hasQuote && quoteState.status !== 'Fresh') {
      return {
        tone: 'warning',
        title: `Quote ${quoteState.status.toLowerCase()}.`,
        body: `Version v${quoteState.version}, expiry slot ${quoteState.expirySlot} (current slot ${quoteState.currentSlot}). Swaps stay disabled until the keeper commits a new staged quote.`,
      };
    }
    return null;
  })();

  const flip = () => {
    setInTokenSymbol(outTokenSymbol);
    setInAmount('');
  };

  const handleSwap = async () => {
    // Hard guard: never sign/submit unless this build is transaction-enabled.
    if (!TRANSACTIONS_ENABLED) {
      setSwapNote({ text: TRANSACTION_DISABLED_REASON ?? 'Transactions are disabled in this build.', ok: false });
      return;
    }
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    if (swapBlockedReason) {
      setSwapNote({ text: swapBlockedReason, ok: false });
      return;
    }
    setIsSwapping(true);
    setSwapNote(null);
    try {
      // S2-35: re-read the live committed quote at submission time. The polled
      // ladder can be up to one poll interval older than the on-chain account,
      // and the deployed quote expires after only `Config.expiry_slots` (10
      // slots ≈2.4 s). Build `min_out` from the *current* committed ladder and
      // submit against its version; refuse on expiry without submitting, so the
      // app can never present a submission the program would reject.
      const fresh = await fetchFreshQuote(connection);
      const freshReason = submitFreshnessReason(fresh);
      if (!fresh || freshReason) {
        setSwapNote({ text: freshReason ?? 'Swaps unavailable: no live on-chain quote.', ok: false });
        return;
      }
      const submitLevels: LadderLevel[] = (isSellingSol ? fresh.bidLevels : fresh.askLevels).map((l) => ({
        sqrtLo: BigInt(l.sqrtLo.toString()),
        sqrtHi: BigInt(l.sqrtHi.toString()),
        liquidity: BigInt(l.liquidity.toString()),
      }));
      const submitAmounts = swapAmountsFromLadder({
        side, amountInAtoms, feeBps, slippageBps, levels: submitLevels,
      });
      if (submitAmounts.capacityExceeded) {
        setSwapNote({
          text: 'Swaps unavailable: the committed ladder cannot fill this size (on-chain capacity cap). Not submitted.',
          ok: false,
        });
        return;
      }
      const submitMinOutHuman = formatUnits(submitAmounts.minOut, outToken.decimals, 6);
      // SOL in = trader sells base; USDC in = trader buys base.
      const ixSide = isSellingSol ? { sellBase: {} } : { buyBase: {} };
      const signature = await swapOnChain(
        connection,
        wallet,
        ixSide as never,
        amountInAtoms,
        submitAmounts.minOut,
        fresh.version,
      );
      // Only report success after the transaction confirmed (the builder awaits
      // confirmation) and then refresh both the wallet balances and vault/quote
      // state so the UI reflects the new on-chain reality.
      setSwapNote({
        text: `Swap confirmed ${signature.slice(0, 8)}… — minimum received enforced on-chain (${submitMinOutHuman} ${outTokenSymbol}).`,
        ok: true,
      });
      await Promise.all([refreshBalances(), refreshProtocol()]);
    } catch (error) {
      setSwapNote({ text: `Swap failed: ${(error as Error).message?.slice(0, 160) ?? 'unknown error'}`, ok: false });
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

      <ReadOnlyBanner detail="Live quote, depth, and balances are read from Devnet, but this build cannot sign or submit swaps." />

      {primaryStatus && (
        <div
          className="uni-card"
          style={{ marginBottom: 12, borderColor: primaryStatus.tone === 'critical' ? 'var(--uni-critical)' : primaryStatus.tone === 'warning' ? 'var(--uni-warning)' : undefined }}
          role={primaryStatus.tone === 'neutral' ? 'status' : 'alert'}
        >
          <strong>{primaryStatus.title}</strong> {primaryStatus.body}
          {lastUpdatedAt && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--uni-neutral2)', marginLeft: 6 }}>
              last read {new Date(lastUpdatedAt * 1000).toLocaleTimeString()} · {stale || transportError ? 'stale' : 'live'}
            </span>
          )}
          {(transportError || stale) && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => retryNow()}>Retry now</button>
              <details style={{ marginTop: 6 }}>
                <summary className="mono" style={{ fontSize: 11, cursor: 'pointer' }}>diagnostics</summary>
                <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
{JSON.stringify({
  vaultState: vaultSource.state,
  errorKind: vaultSource.errorKind,
  endpoint: rpcStatus.endpoint,
  consecutiveFailures: rpcStatus.consecutiveFailures,
  failuresByKind: rpcStatus.failuresByKind,
  lastSuccessAt: rpcStatus.lastSuccessAt ? new Date(rpcStatus.lastSuccessAt).toISOString() : null,
  pollDelayMs: rpcStatus.pollDelayMs,
  autoRetryPaused: rpcStatus.autoRetryPaused,
}, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {rpcStatus.autoRetryPaused && (
        <div className="uni-card" style={{ marginBottom: 12 }} role="status">
          Background retries are paused to avoid hammering the rate-limited provider. Use <strong>Retry now</strong> above to try again.
        </div>
      )}

      <div className="swap-layout">
        {/* ---- Left: Depth Ladder ---- */}
        <div className="depth-ladder-panel">
          <div className="depth-ladder-header">
            <span className="mono depth-ladder-title">{bookHeading}</span>
            <span className="mono depth-ladder-subtitle">
              SOL/USDC · {priceAvailable
                ? `Half-spread: ${quoteState.halfSpreadBps.toFixed(2)} bps${quoteState.status !== 'Fresh' ? ' (last-known)' : ''}`
                : 'Half-spread: N/A'}
            </span>
          </div>

          {!quoteState.hasQuote || !priceAvailable ? (
            <div className="depth-unavailable" role="status" aria-live="polite">
              <strong>
                {rpcRateLimited ? 'RPC rate limited' : transportError ? 'RPC unavailable' : vaultUninitialized ? 'Vault uninitialized' : 'Quote unavailable'}
              </strong>
              <p className="mono">
                {rpcRateLimited || transportError
                  ? 'The quote account could not be read, so no price, spread, or depth is shown. This is an endpoint error — not proof that the vault or quote is absent.'
                  : vaultUninitialized
                    ? 'No vault account exists for the configured mints, so there is nothing to quote.'
                    : 'No readable on-chain quote was found for this vault, so no price, spread, or depth is shown.'}
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
                <span className="mono depth-mid-label">
                  {quoteState.status === 'Fresh' ? 'Pyth Mid' : 'Quoted mid (last-known)'}
                </span>
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
                {inToken.logo && <img src={inToken.logo} alt={inToken.symbol} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                <span>{inToken.symbol}</span>
              </div>
            </div>
            <div className="uni-panel-foot">
              <span>{inTokenSymbol === 'SOL' ? (priceAvailable ? `~$${(parsedInAmount * quoteState.oraclePrice).toFixed(2)} USD` : 'N/A') : `~$${parsedInAmount.toFixed(2)} USD`}</span>
              <span>
                Balance: {!connected ? 'connect wallet' : balancesAvailable ? `${inToken.balance} ${inToken.symbol}` : 'Balance unavailable'}
                {connected && balancesAvailable && (
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
                {outToken.logo && <img src={outToken.logo} alt={outToken.symbol} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                <span>{outToken.symbol}</span>
              </div>
            </div>
            <div className="uni-panel-foot">
              <span>{outTokenSymbol === 'SOL' ? (priceAvailable && expectedOutHuman !== '' ? `~$${(Number(expectedOutHuman) * quoteState.oraclePrice).toFixed(2)} USD (estimate)` : 'N/A') : `~$${Number(expectedOutHuman || 0).toFixed(2)} USD (estimate)`}</span>
              <span>Balance: {!connected ? 'connect wallet' : balancesAvailable ? `${outToken.balance} ${outToken.symbol}` : 'Balance unavailable'}</span>
            </div>
          </div>

          {/* Main CTA — gated by the resolved execution mode + state gate */}
          <button
            type="button"
            className={`uni-main-button ${parsedInAmount > 0 && !submitBlockedReason && connected ? 'accent' : 'disabled'}`}
            disabled={!TRANSACTIONS_ENABLED || parsedInAmount <= 0 || isSwapping || (connected && !!swapBlockedReason)}
            onClick={handleSwap}
          >
            {!TRANSACTIONS_ENABLED ? (
              'Transactions disabled'
            ) : !connected ? (
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

          {submitBlockedReason && (
            <p className="swap-success-note" style={{ color: 'var(--uni-warning)' }}>
              {submitBlockedReason}
            </p>
          )}

          {swapNote && (
            <p
              className="swap-success-note"
              style={{ color: swapNote.ok ? undefined : 'var(--uni-warning)' }}
              role={swapNote.ok ? 'status' : 'alert'}
            >
              {swapNote.ok ? '✓' : '⚠'} {swapNote.text}
            </p>
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
                  Fee: {feeBps} bps {detailsOpen ? '▲' : '▼'}
                </span>
              </button>

              {detailsOpen && (
                <dl className="uni-details-body uni-card" style={{ marginTop: 6, padding: '14px 16px' }}>
                  <div><dt>Quoted oracle reference {quoteState.status !== 'Fresh' ? '(last-known, expired)' : ''}</dt><dd>${quoteState.oraclePrice.toFixed(2)}</dd></div>
                  <div><dt>Reservation Price (P_res)</dt><dd>${quoteState.reservationPrice.toFixed(2)}</dd></div>
                  <div><dt>Dynamic Half-Spread</dt><dd>{quoteState.halfSpreadBps.toFixed(2)} bps</dd></div>
                  <div>
                    <dt>Min. Received (Protected)</dt>
                    <dd style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>
                      {minOutHuman} {outTokenSymbol}
                    </dd>
                  </div>
                  <div><dt>Order Routing</dt><dd>ArbSwap Engine (Direct On-Chain)</dd></div>
                  <div><dt>Quote Expiry Guard</dt><dd>{protocolParams ? `${protocolParams.expirySlots} slots` : 'Unavailable'}</dd></div>
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
