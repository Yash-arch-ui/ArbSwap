import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { solanaConnection, ARBSWAP_VAULT_PUBKEY } from '../chain/solana';
import { deposit as depositOnChain, requestWithdraw as requestWithdrawOnChain, claimWithdraw as claimWithdrawOnChain, crankEpoch as crankEpochOnChain } from '../chain/program';
import { useProtocol } from '../context/ProtocolContext';
import type { WithdrawalTicket } from '../types/protocol';
import './VaultPage.css';
import './SwapPage.css';

interface VaultReceipt {
  type: 'deposit' | 'withdraw';
  txSignature: string;
  isConfirmed: boolean;
  isCancelled?: boolean;
  isError?: boolean;
  message: string;
}

function isWalletCancellation(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const name = (err as { name?: string })?.name || '';
  const code = (err as { code?: number | string })?.code;
  const str = `${name} ${msg} ${code}`.toLowerCase();
  return (
    str.includes('user rejected') ||
    str.includes('rejected') ||
    str.includes('user cancel') ||
    str.includes('cancel') ||
    str.includes('declined') ||
    str.includes('window closed') ||
    str.includes('window blocked') ||
    str.includes('4001')
  );
}

export const VaultPage: React.FC = () => {
  const { vaultState, quoteState, tokens, vaultInitialized, refreshBalances } = useProtocol();
  const { connected, publicKey, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositSol, setDepositSol] = useState<string>('5.0');
  const [depositUsdc, setDepositUsdc] = useState<string>('711.90');
  const [withdrawShares, setWithdrawShares] = useState<string>('20000');
  const [tickets, setTickets] = useState<WithdrawalTicket[]>([]);
  const [userShares, setUserShares] = useState<number | null>(null);
  const [isLoadingShares, setIsLoadingShares] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [receipt, setReceipt] = useState<VaultReceipt | null>(null);

  useEffect(() => {
    setUserShares(connected ? vaultState.userShares : null);
    setIsLoadingShares(false);
  }, [connected, vaultState.userShares, receipt]);

  const solNum = parseFloat(depositSol) || 0;
  const usdcNum = parseFloat(depositUsdc) || 0;
  const estimatedShares = Math.floor(
    Math.min(
      (solNum * vaultState.totalShares) / vaultState.baseReserve,
      (usdcNum * vaultState.totalShares) / vaultState.quoteReserve
    )
  );

  const sharesToWithdraw = parseInt(withdrawShares) || 0;
  const withdrawEstSol = (sharesToWithdraw * vaultState.baseReserve) / vaultState.totalShares;
  const withdrawEstUsdc = (sharesToWithdraw * vaultState.quoteReserve) / vaultState.totalShares;

  const handleDeposit = async () => {
    if (solNum <= 0) return;
    setIsSubmitting(true);
    setReceipt(null);

    if (connected && publicKey) {
      try {
        if (!vaultInitialized) {
          setReceipt({ type: 'deposit', txSignature: '', isConfirmed: false, isError: true, message: 'Vault not initialized on devnet — the tSOL/tUSDC vault has not been created yet.' });
          return;
        }
        const baseAtoms = BigInt(Math.floor(solNum * 1e9));
        const quoteAtoms = BigInt(Math.floor(usdcNum * 1e6));
        const sig = await depositOnChain(solanaConnection, wallet, baseAtoms, quoteAtoms, 1n);
        await refreshBalances();
        setReceipt({
          type: 'deposit',
          txSignature: sig,
          isConfirmed: true,
          message: `Deposit confirmed on Solana devnet (${solNum} tSOL + ${usdcNum} tUSDC). Shares are subject to the warm-up period.`,
        });
      } catch (err: unknown) {
        console.warn('Vault deposit error:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isWalletCancellation(err)) {
          setReceipt({
            type: 'deposit',
            txSignature: '',
            isConfirmed: false,
            isCancelled: true,
            message: 'Deposit transaction was cancelled in your wallet. No funds were deposited.',
          });
        } else {
          setReceipt({
            type: 'deposit',
            txSignature: '',
            isConfirmed: false,
            isError: true,
            message: `Deposit failed on Devnet: ${errMsg.slice(0, 100)}. Check that your wallet has Devnet SOL for gas.`,
          });
        }
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Disconnected simulation
      setTimeout(() => {
        setReceipt({
          type: 'deposit',
          txSignature: `sim_dep_${Date.now().toString(36)}`,
          isConfirmed: false,
          message: `Simulated Devnet Deposit: Minted ~${estimatedShares.toLocaleString()} shares for ${solNum} SOL + $${usdcNum.toFixed(2)} USDC. Activation warm-up: 150 slots (~60s).`,
        });
        setIsSubmitting(false);
      }, 400);
    }
  };

  const handleWithdraw = async () => {
    if (sharesToWithdraw <= 0) return;
    setIsSubmitting(true);
    setReceipt(null);

    const newTicket: WithdrawalTicket = {
      id: `wd-${Math.floor(1000 + Math.random() * 9000)}`,
      shares: sharesToWithdraw,
      requestedEpoch: vaultState.epoch,
      eligibleEpoch: vaultState.epoch + 1,
      estimatedSol: Number(withdrawEstSol.toFixed(2)),
      estimatedUsdc: Number(withdrawEstUsdc.toFixed(2)),
      status: 'Pending',
    };

    if (connected && publicKey) {
      try {
        if (!vaultInitialized) {
          setReceipt({ type: 'withdraw', txSignature: '', isConfirmed: false, isError: true, message: 'Vault not initialized on devnet — nothing to withdraw from.' });
          return;
        }
        const sharesAtoms = BigInt(Math.floor(sharesToWithdraw * 1e9));
        const sig = await requestWithdrawOnChain(solanaConnection, wallet, sharesAtoms);
        await refreshBalances();
        setTickets([newTicket, ...tickets]);
        setReceipt({
          type: 'withdraw',
          txSignature: sig,
          isConfirmed: true,
          message: `Withdrawal requested on Solana devnet for Epoch ${vaultState.epoch + 1} (${sharesToWithdraw} shares).`,
        });
      } catch (err: unknown) {
        console.warn('Vault withdrawal error:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isWalletCancellation(err)) {
          setReceipt({
            type: 'withdraw',
            txSignature: '',
            isConfirmed: false,
            isCancelled: true,
            message: 'Withdrawal queue transaction was cancelled in your wallet. No ticket was queued.',
          });
        } else {
          setReceipt({
            type: 'withdraw',
            txSignature: '',
            isConfirmed: false,
            isError: true,
            message: `Withdrawal queue failed on Devnet: ${errMsg.slice(0, 100)}. Check that your wallet has Devnet SOL for gas.`,
          });
        }
      } finally {
        setIsSubmitting(false);
      }
    } else {
      setTimeout(() => {
        setTickets([newTicket, ...tickets]);
        setReceipt({
          type: 'withdraw',
          txSignature: `sim_wd_${Date.now().toString(36)}`,
          isConfirmed: false,
          message: `Simulated Withdrawal: Ticket ${newTicket.id} queued for Epoch ${vaultState.epoch + 1} (${withdrawEstSol.toFixed(2)} SOL + $${withdrawEstUsdc.toFixed(2)} USDC).`,
        });
        setIsSubmitting(false);
      }, 400);
    }
  };

  const handleClaim = async () => {
    if (!connected || !publicKey) { setVisible(true); return; }
    setIsSubmitting(true);
    setReceipt(null);
    try {
      if (!vaultInitialized) {
        setReceipt({ type: 'withdraw', txSignature: '', isConfirmed: false, isError: true, message: 'Vault not initialized on devnet.' });
        return;
      }
      const sig = await claimWithdrawOnChain(solanaConnection, wallet);
      await refreshBalances();
      setReceipt({ type: 'withdraw', txSignature: sig, isConfirmed: true, message: 'Claimed settled withdrawal on Solana devnet.' });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setReceipt({ type: 'withdraw', txSignature: '', isConfirmed: false, isError: true, message: `Claim failed: ${errMsg.slice(0, 100)}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCrank = async () => {
    if (!connected || !publicKey) { setVisible(true); return; }
    setIsSubmitting(true);
    setReceipt(null);
    try {
      const sig = await crankEpochOnChain(solanaConnection, wallet);
      await refreshBalances();
      setReceipt({ type: 'withdraw', txSignature: sig, isConfirmed: true, message: 'Epoch cranked on Solana devnet.' });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setReceipt({ type: 'withdraw', txSignature: '', isConfirmed: false, isError: true, message: `Crank failed: ${errMsg.slice(0, 100)}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="vault-container">
      <div>
        <div className="vault-header-row">
          <div>
            <h1 className="uni-headline">Active Market-Making Vault</h1>
            <p className="uni-subheadline">
              Deposit SOL and USDC pro-rata. The vault continuously quotes two-sided liquidity on Solana and captures trading fees with bounded risk.
            </p>
          </div>
          <div className="vault-cluster-badge">
            <span className="vault-cluster-pulse" />
            <span>Devnet Vault: {ARBSWAP_VAULT_PUBKEY.toBase58().slice(0, 6)}... (Epoch {vaultState.epoch})</span>
          </div>
        </div>
      </div>

      {/* Top 4 Stats in reference style */}
      <div className="vault-stat-grid">
        <div className="vault-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vault-stat-label">Total Value Locked</span>
            <span style={{ fontSize: 10, color: 'var(--uni-neutral2)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4 }}>Model Est.</span>
          </div>
          <p className="vault-stat-value">${vaultState.tvlUsd.toLocaleString()}</p>
          <span className="vault-stat-subtext">{vaultState.baseReserve.toLocaleString()} SOL + ${vaultState.quoteReserve.toLocaleString()} USDC</span>
        </div>
        <div className="vault-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vault-stat-label">Vault Status</span>
          </div>
          <p className="vault-stat-value">{vaultState.status}</p>
          <span className="vault-stat-subtext">Epoch {vaultState.epoch} · warm-up {vaultState.warmupSlots} slots</span>
        </div>
        <div className="vault-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vault-stat-label">LVR Avoided (7-Day)</span>
            <span style={{ fontSize: 10, color: 'var(--uni-success)', background: 'rgba(0,229,176,0.1)', padding: '1px 6px', borderRadius: 4 }}>Model Est.</span>
          </div>
          <p className="vault-stat-value" style={{ color: 'var(--uni-success)' }}>+${vaultState.lvrAvoided7dUsd.toLocaleString()}</p>
          <span className="vault-stat-subtext">Saved vs passive pool toxic flow</span>
        </div>
        <div className="vault-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vault-stat-label">Current Epoch</span>
            <span style={{ fontSize: 10, color: 'var(--uni-success)', fontWeight: 600 }}>● Live Chain</span>
          </div>
          <p className="vault-stat-value">Epoch {vaultState.epoch}</p>
          <span className="vault-stat-subtext">{vaultState.epochSlotsRemaining} slots remaining</span>
        </div>
      </div>

      {/* Split: Deposit Terminal (Left) + Inventory & Queue (Right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 24, alignItems: 'start' }}>
        
        {/* Left: Terminal */}
        <div className="uni-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          {/* Segmented Tab Controls — Highly visible UI */}
          <div className="vault-tab-container">
            <button 
              type="button" 
              className={`vault-tab-btn ${activeTab === 'deposit' ? 'active' : ''}`}
              onClick={() => { setActiveTab('deposit'); setReceipt(null); }}
            >
              Deposit (Pro-Rata)
            </button>
            <button 
              type="button" 
              className={`vault-tab-btn ${activeTab === 'withdraw' ? 'active' : ''}`}
              onClick={() => { setActiveTab('withdraw'); setReceipt(null); }}
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
                    <img src={tokens.SOL.logo} alt="SOL" />
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
                    <img src={tokens.USDC.logo} alt="USDC" />
                    <span>USDC</span>
                  </div>
                </div>
              </div>

              <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--uni-neutral2)' }}>Shares to Mint:</span>
                <span className="mono" style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>~{estimatedShares.toLocaleString()} shares</span>
              </div>

              <button 
                type="button" 
                className="uni-main-button accent" 
                onClick={handleDeposit}
                disabled={isSubmitting}
              >
                {isSubmitting 
                  ? 'Confirming on Devnet...' 
                  : connected 
                  ? 'Sign & Deposit pro-rata on Devnet' 
                  : 'Deposit pro-rata (Simulation)'}
              </button>

              {!connected && (
                <button type="button" className="uni-connect-sublink" onClick={() => setVisible(true)}>
                  Or connect Phantom / Solflare for on-chain deposit →
                </button>
              )}
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

              <button 
                type="button" 
                className="uni-main-button accent" 
                onClick={handleWithdraw}
                disabled={isSubmitting}
              >
                {isSubmitting 
                  ? 'Queueing on Devnet...' 
                  : connected 
                  ? 'Sign & Queue withdrawal on Devnet' 
                  : 'Queue withdrawal (Simulation)'}
              </button>

              <button type="button" className="uni-connect-sublink" onClick={handleCrank} disabled={isSubmitting}>
                Crank epoch (permissionless)
              </button>
              <button type="button" className="uni-connect-sublink" onClick={handleClaim} disabled={isSubmitting}>
                Claim settled withdrawal
              </button>

              {!connected && (
                <button type="button" className="uni-connect-sublink" onClick={() => setVisible(true)}>
                  Or connect Phantom / Solflare for on-chain withdrawal →
                </button>
              )}
            </div>
          )}

          {receipt && (
            <div 
              className="vault-receipt-box"
              style={
                receipt.isCancelled
                  ? { border: '1px solid rgba(255, 170, 0, 0.4)', background: 'rgba(255, 170, 0, 0.08)' }
                  : receipt.isError
                  ? { border: '1px solid rgba(255, 80, 80, 0.4)', background: 'rgba(255, 80, 80, 0.08)' }
                  : undefined
              }
            >
              <div 
                style={{ 
                  fontWeight: 600, 
                  color: receipt.isCancelled 
                    ? 'var(--uni-warning, #f5a623)' 
                    : receipt.isError 
                    ? '#ff5050' 
                    : 'var(--uni-accent1)', 
                  marginBottom: 4 
                }}
              >
                {receipt.isCancelled
                  ? '✕ Transaction Cancelled'
                  : receipt.isError
                  ? '✕ Transaction Failed'
                  : receipt.isConfirmed
                  ? '✓ Devnet Transaction Confirmed'
                  : '✓ Execution Notice'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--uni-neutral1)' }}>{receipt.message}</div>
              {receipt.isConfirmed && receipt.txSignature && (
                <div style={{ marginTop: 6, fontFamily: 'var(--uni-mono)', fontSize: 11 }}>
                  Tx Reference:{' '}
                  <a
                    href={`https://explorer.solana.com/tx/${receipt.txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {receipt.txSignature} ↗ (View on Solana Explorer)
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Inventory & Queue */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="uni-card">
            <h3 style={{ fontSize: 16, fontWeight: 535, marginBottom: 12 }}>Inventory Skew (Avellaneda-Stoikov)</h3>
            <div className="vault-skew-container">
              <div 
                className="vault-skew-sol" 
                style={{ width: `${(vaultState.currentRatio * 100).toFixed(1)}%` }}
              >
                SOL ({(vaultState.currentRatio * 100).toFixed(1)}%)
              </div>
              <div 
                className="vault-skew-usdc" 
                style={{ width: `${((1 - vaultState.currentRatio) * 100).toFixed(1)}%` }}
              >
                USDC ({((1 - vaultState.currentRatio) * 100).toFixed(1)}%)
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16, fontSize: 13 }}>
              <div>
                <span style={{ color: 'var(--uni-neutral2)' }}>Insurance Buffer:</span>{' '}
                <strong className="mono" style={{ color: 'var(--uni-success)' }}>${vaultState.insuranceBufferUsd.toLocaleString()}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--uni-neutral2)' }}>Keeper Reward Pool:</span>{' '}
                <strong className="mono" style={{ color: 'var(--uni-accent1)' }}>${vaultState.keeperPoolUsd.toLocaleString()}</strong>
              </div>
            </div>
          </div>

          <div className="uni-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, fontWeight: 535, margin: 0 }}>Your Position & Tickets</h3>
              <span style={{ fontSize: 10, color: 'var(--uni-success)', fontWeight: 600 }}>● Live On-Chain</span>
            </div>

            <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--uni-neutral2)', marginBottom: 4 }}>Your LP Share Balance (Devnet)</div>
              <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--uni-mono)' }}>
                {!connected ? (
                  <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Connect wallet to view</span>
                ) : isLoadingShares ? (
                  <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Querying RPC...</span>
                ) : (
                  <span>{(userShares ?? 0).toLocaleString()} LP Shares</span>
                )}
              </div>
            </div>

            <div style={{ fontSize: 13, fontWeight: 535, marginBottom: 8, color: 'var(--uni-neutral1)' }}>Epoch Withdrawal Queue</div>
            {tickets.length > 0 ? (
              tickets.map(t => (
                <div key={t.id} className="vault-ticket-item">
                  <div>
                    <span className="mono" style={{ fontWeight: 600 }}>{t.id}</span>
                    <div style={{ color: 'var(--uni-neutral2)', fontSize: 12 }}>
                      {t.shares.toLocaleString()} shares → {t.estimatedSol} SOL + ${t.estimatedUsdc} USDC
                    </div>
                  </div>
                  <span className="mono" style={{ color: t.status === 'Ready' ? 'var(--uni-success)' : 'var(--uni-warning)', fontSize: 12 }}>
                    {t.status} (Epoch {t.eligibleEpoch})
                  </span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: 'var(--uni-neutral2)', fontStyle: 'italic', padding: '6px 0' }}>
                {connected ? 'No active withdrawal tickets queued in current epoch.' : 'Connect wallet to view queued epoch redemption tickets.'}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
