import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { APP_RPC_FAILOVER } from '../chain/rpcFailover';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import { deposit as depositOnChain, requestWithdraw as requestWithdrawOnChain, claimWithdraw as claimWithdrawOnChain, withdrawTicket as deriveWithdrawTicket, expectedDepositShares } from '../chain/program';
import { parseUnits, formatUnits } from '../chain/amounts';
import { claimWithdrawState } from '../chain/gating';
import { ACTIVE_VAULT, BASE_MINT, TRANSACTIONS_ENABLED, TRANSACTION_DISABLED_REASON, explorerTxUrl } from '../chain/config';
import { MIN_SOL_FOR_FEES } from '../chain/wrappedSol';
import { NATIVE_MINT } from '@solana/spl-token';
import { ReadOnlyBanner } from '../components/ReadOnlyMode';

export const VaultPage: React.FC = () => {
  const {
    vaultState,
    quoteState,
    tokens,
    refreshBalances,
    refreshProtocol,
    vaultInitialized,
    depositTicket,
    withdrawTicket,
    shareBalanceAtoms,
    vaultAtoms,
    walletAtoms,
  } = useProtocol();
  const connection = APP_RPC_FAILOVER.connection;
  const { connected, publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositSol, setDepositSol] = useState<string>('0.1');
  const [depositUsdc, setDepositUsdc] = useState<string>('11.00');
  const [withdrawShares, setWithdrawShares] = useState<string>('0');
  // Notice carries a severity so the UI never shows a success check on a failure.
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);

  const disabledReason = TRANSACTION_DISABLED_REASON;
  const blocked = (): boolean => {
    if (!TRANSACTIONS_ENABLED) {
      setNotice({ text: disabledReason ?? 'Transactions are disabled in this build.', ok: false });
      return true;
    }
    return false;
  };

  const claimState = claimWithdrawState({
    walletConnected: connected,
    hasTicket: !!withdrawTicket,
    ticketEpoch: withdrawTicket?.requestedEpoch ?? 0,
    vaultEpoch: vaultState.epoch,
    ticketShares: withdrawTicket?.shares ?? 0n,
  });

  const solNum = parseFloat(depositSol) || 0;
  const usdcNum = parseFloat(depositUsdc) || 0;
  const estimatedShares = Math.floor(
    Math.min(
      (solNum * vaultState.totalShares) / vaultState.baseReserve,
      (usdcNum * vaultState.totalShares) / vaultState.quoteReserve
    )
  );

  const sharesToWithdrawAtoms = (() => {
    try {
      return parseUnits(withdrawShares, ACTIVE_VAULT.shareDecimals);
    } catch {
      return 0n;
    }
  })();
  const withdrawEstSol =
    vaultState.totalShares > 0
      ? (Number(sharesToWithdrawAtoms) / 10 ** ACTIVE_VAULT.shareDecimals) * (vaultState.baseReserve / vaultState.totalShares)
      : 0;
  const withdrawEstUsdc =
    vaultState.totalShares > 0
      ? (Number(sharesToWithdrawAtoms) / 10 ** ACTIVE_VAULT.shareDecimals) * (vaultState.quoteReserve / vaultState.totalShares)
      : 0;

  const handleDeposit = async () => {
    if (blocked()) return;
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setNotice({ text: 'Submitting deposit…', ok: false });
    try {
      const base = parseUnits(depositSol, tokens.SOL.decimals);
      const quote = parseUnits(depositUsdc, tokens.USDC.decimals);
      // SOL is auto-wrapped; never wrap so much that no SOL is left for fees.
      if (BASE_MINT.equals(NATIVE_MINT) && walletAtoms && base > walletAtoms.base) {
        const wrapNeeded = base - walletAtoms.base;
        if (walletAtoms.sol < wrapNeeded + MIN_SOL_FOR_FEES) {
          throw new Error(`Wrapping this deposit would leave less than ${formatUnits(MIN_SOL_FOR_FEES, tokens.SOL.decimals)} SOL for fees. Lower the amount.`);
        }
      }
      if (!vaultAtoms) throw new Error('vault state not loaded yet');
      const expected = expectedDepositShares({
        baseAmount: base,
        quoteAmount: quote,
        ...vaultAtoms,
      });
      if (expected <= 0n) throw new Error('deposit too small for the current vault');
      const minShares = (expected * 9950n) / 10000n; // 0.5% slippage floor
      const signature = await depositOnChain(connection, wallet, base, quote, minShares);
      setNotice({ text: `Deposit confirmed ${signature.slice(0, 8)}… — ${explorerTxUrl(signature)} (shares activate after warm-up).`, ok: true });
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const human = /user rejected|rejected the request|declined|cancel/i.test(msg)
        ? 'Deposit signing was cancelled by user.'
        : `Deposit failed: ${msg.slice(0, 120)}`;
      setNotice({ text: human, ok: false });
    }
  };

  const handleWithdraw = async () => {
    if (blocked()) return;
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setNotice({ text: 'Queueing withdrawal…', ok: false });
    try {
      const signature = await requestWithdrawOnChain(connection, wallet, sharesToWithdrawAtoms);
      setNotice({ text: `Withdrawal queued ${signature.slice(0, 8)}… for Epoch ${vaultState.epoch + 1}.`, ok: true });
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const human = /user rejected|rejected the request|declined|cancel/i.test(msg)
        ? 'Withdrawal queue signing was cancelled by user.'
        : `Withdraw request failed: ${msg.slice(0, 120)}`;
      setNotice({ text: human, ok: false });
    }
  };

  const handleClaim = async () => {
    if (blocked()) return;
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    if (!claimState.allowed) {
      setNotice({ text: claimState.reason, ok: false });
      return;
    }
    setIsClaiming(true);
    setNotice({ text: 'Claiming settled withdrawal…', ok: false });
    try {
      const signature = await claimWithdrawOnChain(connection, wallet);
      setNotice({ text: `Claim confirmed ${signature.slice(0, 8)}… — ${explorerTxUrl(signature)}`, ok: true });
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const human = /user rejected|rejected the request|declined|cancel/i.test(msg)
        ? 'Claim signing was cancelled by user.'
        : `Claim failed: ${msg.slice(0, 120)}`;
      setNotice({ text: human, ok: false });
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32 }}>
      <div>
        <h1 className="uni-headline">Active Market-Making Vault</h1>
        <p className="uni-subheadline">
          Deposit {tokens.SOL.symbol} and {tokens.USDC.symbol} pro-rata. The vault continuously quotes two-sided liquidity and captures trading fees with bounded risk.
        </p>
      </div>

      <ReadOnlyBanner detail="Reserves, shares, tickets and epoch state are read live from Devnet; deposit, withdrawal and claim are disabled in this build." />

      {!vaultInitialized && (
        <div className="uni-card">
          <strong>Vault not initialized.</strong> No on-chain vault exists for the
          {tokens.SOL.symbol}/{tokens.USDC.symbol} pair yet, so deposit and withdrawal are disabled.
        </div>
      )}

      {/* Top 4 Stats in reference style */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <div className="uni-card" style={{ padding: '20px 22px', border: '1px solid rgba(255,255,255,0.08)', background: 'var(--uni-surface1)', borderRadius: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Total Value Locked</span>
            <span style={{ fontSize: 10, color: 'var(--uni-neutral2)', background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4 }}>Model Est.</span>
          </div>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, margin: '8px 0 4px', color: 'var(--uni-neutral1)' }}>${vaultState.tvlUsd.toLocaleString()}</p>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>{vaultState.baseReserve.toLocaleString()} SOL + ${vaultState.quoteReserve.toLocaleString()} USDC</span>
        </div>
        <div className="uni-card" style={{ padding: '20px 22px', border: '1px solid rgba(255,255,255,0.08)', background: 'var(--uni-surface1)', borderRadius: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Hedged Alpha APY</span>
            <span style={{ fontSize: 10, color: 'var(--uni-accent1)', background: 'rgba(240,180,0,0.1)', padding: '2px 6px', borderRadius: 4 }}>Model Est.</span>
          </div>
          <p className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--uni-accent1)', margin: '8px 0 4px' }}>+{vaultState.netHedgedApy}%</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Trading fees minus adverse selection</span>
        </div>
        <div className="uni-card" style={{ padding: '20px 22px', border: '1px solid rgba(255,255,255,0.08)', background: 'var(--uni-surface1)', borderRadius: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>LVR Avoided (7-Day)</span>
            <span style={{ fontSize: 10, color: 'var(--uni-success)', background: 'rgba(0,229,176,0.1)', padding: '2px 6px', borderRadius: 4 }}>Model Est.</span>
          </div>
          <p className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--uni-success)', margin: '8px 0 4px' }}>+${vaultState.lvrAvoided7dUsd.toLocaleString()}</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Saved vs passive pool toxic flow</span>
        </div>
        <div className="uni-card" style={{ padding: '20px 22px', border: '1px solid rgba(255,255,255,0.08)', background: 'var(--uni-surface1)', borderRadius: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Current Epoch</span>
            <span style={{ fontSize: 10, color: 'var(--uni-success)', fontWeight: 600 }}>● Live Chain</span>
          </div>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, margin: '8px 0 4px', color: 'var(--uni-neutral1)' }}>Epoch {vaultState.epoch}</p>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>{vaultState.epochSlotsRemaining} slots remaining</span>
        </div>
      </div>

      {/* Split: Deposit Terminal (Left) + Inventory & Queue (Right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 24 }}>
        
        {/* Left: Terminal */}
        <div className="uni-card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--uni-surface3)', paddingBottom: 12 }}>
            <button 
              type="button" 
              className={`uni-button ${activeTab === 'deposit' ? 'uni-button-accent' : 'uni-button-ghost'}`}
              onClick={() => setActiveTab('deposit')}
            >
              Deposit (Pro-Rata)
            </button>
            <button 
              type="button" 
              className={`uni-button ${activeTab === 'withdraw' ? 'uni-button-accent' : 'uni-button-ghost'}`}
              onClick={() => setActiveTab('withdraw')}
            >
              Withdraw (Epoch Queue)
            </button>
          </div>

          {activeTab === 'deposit' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                <strong>Pro-Rata Two-Token Accounting (D-05):</strong> Deposits contribute both SOL and USDC proportional to current pool reserves. No oracle is used in share calculation.
                <br />
                <span style={{ color: 'var(--uni-accent1)' }}>Your SOL is auto-wrapped to WSOL in the same transaction — no manual wrap needed.</span>
              </p>

              <div className="uni-panel uni-panel-sell">
                <span className="uni-panel-label">SOL Deposit</span>
                <div className="uni-panel-row">
                  <input 
                    className="uni-amount mono" 
                    value={depositSol} 
                    onChange={(e) => {
                      setDepositSol(e.target.value);
                      const n = parseFloat(e.target.value) || 0;
                      setDepositUsdc((n * quoteState.oraclePrice).toFixed(2));
                    }}
                  />
                  <div className="uni-token-pill">
                    {tokens.SOL.logo && <img src={tokens.SOL.logo} alt={tokens.SOL.symbol} />}
                    <span>SOL</span>
                  </div>
                </div>
              </div>

              <div className="uni-panel uni-panel-sell">
                <span className="uni-panel-label">USDC Deposit</span>
                <div className="uni-panel-row">
                  <input 
                    className="uni-amount mono" 
                    value={depositUsdc} 
                    onChange={(e) => {
                      setDepositUsdc(e.target.value);
                      const n = parseFloat(e.target.value) || 0;
                      setDepositSol((n / quoteState.oraclePrice).toFixed(4));
                    }}
                  />
                  <div className="uni-token-pill">
                    {tokens.USDC.logo && <img src={tokens.USDC.logo} alt={tokens.USDC.symbol} />}
                    <span>USDC</span>
                  </div>
                </div>
              </div>

              <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--uni-neutral2)' }}>Shares to Mint:</span>
                <span className="mono" style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>~{estimatedShares.toLocaleString()} shares</span>
              </div>

              <button type="button" className="uni-main-button accent" onClick={handleDeposit} disabled={!TRANSACTIONS_ENABLED || !vaultInitialized}>
                {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : !vaultInitialized ? 'Vault not initialized' : !connected ? 'Connect wallet' : 'Deposit pro-rata'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                <strong>Epoch Queue (M10):</strong> Withdrawals request in Epoch {vaultState.epoch} and settle in Epoch {vaultState.epoch + 1} pro-rata against actual reserves to prevent sandwich attacks.
              </p>

              <div className="uni-panel uni-panel-sell">
                <span className="uni-panel-label">Shares to Redeem</span>
                <div className="uni-panel-row">
                  <input 
                    className="uni-amount mono" 
                    value={withdrawShares} 
                    onChange={(e) => setWithdrawShares(e.target.value)}
                  />
                  <button type="button" className="uni-max" onClick={() => setWithdrawShares(vaultState.userShares.toString())}>
                    Max
                  </button>
                </div>
              </div>

              <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--uni-neutral2)' }}>Est. Base Output:</span>
                  <span className="mono">{withdrawEstSol.toFixed(4)} SOL</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--uni-neutral2)' }}>Est. Quote Output:</span>
                  <span className="mono">${withdrawEstUsdc.toFixed(2)} USDC</span>
                </div>
              </div>

              <button type="button" className="uni-main-button accent" onClick={handleWithdraw} disabled={!TRANSACTIONS_ENABLED || !vaultInitialized}>
                {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : !vaultInitialized ? 'Vault not initialized' : !connected ? 'Connect wallet' : 'Queue withdrawal for next epoch'}
              </button>

              <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ color: 'var(--uni-neutral2)' }}>Claim status</span>
                  <span className="mono" style={{ color: claimState.allowed ? 'var(--uni-success)' : 'var(--uni-neutral2)', textAlign: 'right' }}>
                    {claimState.reason}
                  </span>
                </div>
                <button
                  type="button"
                  className={`uni-main-button ${claimState.allowed && TRANSACTIONS_ENABLED ? 'accent' : 'disabled'}`}
                  onClick={handleClaim}
                  disabled={!TRANSACTIONS_ENABLED || !claimState.allowed || isClaiming}
                >
                  {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : isClaiming ? 'Claiming…' : claimState.allowed ? 'Claim settled withdrawal' : 'Claim unavailable'}
                </button>
              </div>
            </div>
          )}

          {notice && (
            <div
              className={`vault-status-card ${notice.ok ? 'success' : notice.text.toLowerCase().includes('cancel') || notice.text.toLowerCase().includes('reject') ? 'cancelled' : 'error'}`}
              style={{
                marginTop: 14,
                padding: '12px 16px',
                borderRadius: 12,
                border: notice.ok 
                  ? '1px solid rgba(0, 229, 176, 0.4)' 
                  : notice.text.toLowerCase().includes('cancel') || notice.text.toLowerCase().includes('reject')
                  ? '1px solid rgba(255, 170, 0, 0.4)'
                  : '1px solid rgba(255, 80, 80, 0.4)',
                background: notice.ok 
                  ? 'rgba(0, 229, 176, 0.08)' 
                  : notice.text.toLowerCase().includes('cancel') || notice.text.toLowerCase().includes('reject')
                  ? 'rgba(255, 170, 0, 0.08)'
                  : 'rgba(255, 80, 80, 0.08)',
              }}
              role={notice.ok ? 'status' : 'alert'}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: 600,
                fontSize: 13,
                color: notice.ok 
                  ? 'var(--uni-success, #00e5b0)' 
                  : notice.text.toLowerCase().includes('cancel') || notice.text.toLowerCase().includes('reject')
                  ? 'var(--uni-warning, #f5a623)'
                  : '#ff5050',
                marginBottom: 4,
              }}>
                <span>
                  {notice.ok 
                    ? '✓ Operation Confirmed' 
                    : notice.text.toLowerCase().includes('cancel') || notice.text.toLowerCase().includes('reject')
                    ? '✕ Request Cancelled'
                    : '✕ Request Failed'}
                </span>
                <span style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'rgba(255, 255, 255, 0.1)',
                  fontWeight: 500,
                }}>
                  {notice.ok ? 'On-Chain Devnet' : notice.text.toLowerCase().includes('cancel') ? 'Wallet Notice' : 'Notice'}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--uni-neutral1)', lineHeight: 1.5 }}>
                {notice.text}
              </p>
            </div>
          )}
        </div>

        {/* Right: Inventory & Queue */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="uni-card">
            <h3 style={{ fontSize: 16, fontWeight: 535, marginBottom: 12 }}>Inventory Skew (Avellaneda-Stoikov)</h3>
            <div style={{ display: 'flex', height: 26, borderRadius: 13, overflow: 'hidden', fontSize: 12, fontWeight: 600, textAlign: 'center', lineHeight: '26px' }}>
              <div style={{ width: `${(vaultState.currentRatio * 100).toFixed(1)}%`, background: 'rgba(0, 229, 176, 0.25)', color: 'var(--uni-accent1)' }}>
                SOL ({(vaultState.currentRatio * 100).toFixed(1)}%)
              </div>
              <div style={{ width: `${((1 - vaultState.currentRatio) * 100).toFixed(1)}%`, background: 'rgba(255, 255, 255, 0.15)', color: 'var(--uni-neutral1)' }}>
                USDC ({((1 - vaultState.currentRatio) * 100).toFixed(1)}%)
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16, fontSize: 13 }}>
              <div><span style={{ color: 'var(--uni-neutral2)' }}>Insurance Buffer:</span> <strong className="mono" style={{ color: 'var(--uni-success)' }}>${vaultState.insuranceBufferUsd.toLocaleString()}</strong></div>
              <div><span style={{ color: 'var(--uni-neutral2)' }}>Keeper Reward Pool:</span> <strong className="mono" style={{ color: 'var(--uni-accent1)' }}>${vaultState.keeperPoolUsd.toLocaleString()}</strong></div>
            </div>
          </div>

          <div className="uni-card">
            <h3 style={{ fontSize: 16, fontWeight: 535, marginBottom: 12 }}>Your Position (live on-chain)</h3>
            <div style={{ color: 'var(--uni-neutral2)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                Share balance:{' '}
                <strong className="mono" style={{ color: 'var(--uni-neutral1)' }}>
                  {!publicKey
                    ? 'connect a wallet'
                    : shareBalanceAtoms === null
                      ? 'no share account'
                      : formatUnits(shareBalanceAtoms, ACTIVE_VAULT.shareDecimals)}
                </strong>
              </div>
              <div>
                Deposit ticket:{' '}
                {depositTicket ? (
                  <span className="mono">
                    {formatUnits(depositTicket.shares, ACTIVE_VAULT.shareDecimals)} shares ·{' '}
                    {depositTicket.active ? 'active' : `activating at slot ${depositTicket.activateSlot}`}
                  </span>
                ) : (
                  <span>none</span>
                )}
              </div>
              <div>
                Withdrawal ticket:{' '}
                {withdrawTicket ? (
                  <span className="mono">
                    {formatUnits(withdrawTicket.shares, ACTIVE_VAULT.shareDecimals)} shares · requested epoch {withdrawTicket.requestedEpoch}
                  </span>
                ) : (
                  <span>none</span>
                )}
              </div>
              {publicKey && withdrawTicket && (
                <span style={{ color: 'var(--uni-neutral3)', fontSize: 12 }}>
                  Redemption PDA: <span className="mono">{deriveWithdrawTicket(ACTIVE_VAULT.vault, publicKey).toBase58()}</span>
                </span>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
