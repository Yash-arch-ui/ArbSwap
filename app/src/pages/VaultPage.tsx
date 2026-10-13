import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { APP_RPC_FAILOVER } from '../chain/rpcFailover';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import { deposit as depositOnChain, requestWithdraw as requestWithdrawOnChain, claimWithdraw as claimWithdrawOnChain, withdrawTicket as deriveWithdrawTicket, expectedDepositShares } from '../chain/program';
import { parseUnits, formatUnits } from '../chain/amounts';
import { claimWithdrawState } from '../chain/gating';
import { ACTIVE_VAULT, READ_ONLY_MODE, explorerTxUrl } from '../chain/config';
import { ReadOnlyBanner, READ_ONLY_NOTICE } from '../components/ReadOnlyMode';

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
  } = useProtocol();
  const connection = APP_RPC_FAILOVER.connection;
  const { connected, publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositSol, setDepositSol] = useState<string>('0.1');
  const [depositUsdc, setDepositUsdc] = useState<string>('11.00');
  const [withdrawShares, setWithdrawShares] = useState<string>('0');
  const [notice, setNotice] = useState<string | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);

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
    if (READ_ONLY_MODE) { setNotice(READ_ONLY_NOTICE); return; }
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setNotice('Submitting deposit…');
    try {
      const base = parseUnits(depositSol, tokens.SOL.decimals);
      const quote = parseUnits(depositUsdc, tokens.USDC.decimals);
      if (!vaultAtoms) throw new Error('vault state not loaded yet');
      const expected = expectedDepositShares({
        baseAmount: base,
        quoteAmount: quote,
        ...vaultAtoms,
      });
      if (expected <= 0n) throw new Error('deposit too small for the current vault');
      const minShares = (expected * 9950n) / 10000n; // 0.5% slippage floor
      const signature = await depositOnChain(connection, wallet, base, quote, minShares);
      setNotice(`Deposit confirmed ${signature.slice(0, 8)}… — ${explorerTxUrl(signature)} (shares activate after warm-up).`);
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      setNotice(`Deposit failed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}`);
    }
  };

  const handleWithdraw = async () => {
    if (READ_ONLY_MODE) { setNotice(READ_ONLY_NOTICE); return; }
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setNotice('Queueing withdrawal…');
    try {
      const signature = await requestWithdrawOnChain(connection, wallet, sharesToWithdrawAtoms);
      setNotice(`Withdrawal queued ${signature.slice(0, 8)}… for Epoch ${vaultState.epoch + 1}.`);
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      setNotice(`Withdraw request failed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}`);
    }
  };

  const handleClaim = async () => {
    if (READ_ONLY_MODE) { setNotice(READ_ONLY_NOTICE); return; }
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    if (!claimState.allowed) {
      setNotice(claimState.reason);
      return;
    }
    setIsClaiming(true);
    setNotice('Claiming settled withdrawal…');
    try {
      const signature = await claimWithdrawOnChain(connection, wallet);
      setNotice(`Claim confirmed ${signature.slice(0, 8)}… — ${explorerTxUrl(signature)}`);
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      setNotice(`Claim failed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}`);
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
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Total Value Locked</span>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, margin: '8px 0 4px' }}>${vaultState.tvlUsd.toLocaleString()}</p>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>{vaultState.baseReserve.toLocaleString()} SOL + ${vaultState.quoteReserve.toLocaleString()} USDC</span>
        </div>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Hedged Alpha (annualized)</span>
          <p className="mono" style={{ fontSize: 20, fontWeight: 600, color: 'var(--uni-neutral2)', margin: '8px 0 4px' }}>Unavailable</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Not derivable from on-chain state (not indexed)</span>
        </div>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>LVR Avoided (7-Day)</span>
          <p className="mono" style={{ fontSize: 20, fontWeight: 600, color: 'var(--uni-neutral2)', margin: '8px 0 4px' }}>Unavailable</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Requires indexed trade history (not indexed)</span>
        </div>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Current Epoch</span>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, margin: '8px 0 4px' }}>Epoch {vaultState.epoch}</p>
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

              <button type="button" className="uni-main-button accent" onClick={handleDeposit} disabled={READ_ONLY_MODE || !vaultInitialized}>
                {READ_ONLY_MODE ? 'Read-only mode' : !vaultInitialized ? 'Vault not initialized' : !connected ? 'Connect wallet' : 'Deposit pro-rata'}
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

              <button type="button" className="uni-main-button accent" onClick={handleWithdraw} disabled={READ_ONLY_MODE || !vaultInitialized}>
                {READ_ONLY_MODE ? 'Read-only mode' : !vaultInitialized ? 'Vault not initialized' : !connected ? 'Connect wallet' : 'Queue withdrawal for next epoch'}
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
                  className={`uni-main-button ${claimState.allowed && !READ_ONLY_MODE ? 'accent' : 'disabled'}`}
                  onClick={handleClaim}
                  disabled={READ_ONLY_MODE || !claimState.allowed || isClaiming}
                >
                  {READ_ONLY_MODE ? 'Read-only mode' : isClaiming ? 'Claiming…' : claimState.allowed ? 'Claim settled withdrawal' : 'Claim unavailable'}
                </button>
              </div>
            </div>
          )}

          {notice && <p style={{ color: 'var(--uni-success)', fontSize: 13, textAlign: 'center' }}>✓ {notice}</p>}
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
