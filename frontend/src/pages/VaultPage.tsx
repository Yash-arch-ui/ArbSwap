import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import { MOCK_USER_TICKETS } from '../data/mockData';
import type { WithdrawalTicket } from '../types/protocol';

export const VaultPage: React.FC = () => {
  const { vaultState, quoteState, tokens } = useProtocol();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositSol, setDepositSol] = useState<string>('5.0');
  const [depositUsdc, setDepositUsdc] = useState<string>('711.90');
  const [withdrawShares, setWithdrawShares] = useState<string>('20000');
  const [tickets, setTickets] = useState<WithdrawalTicket[]>(MOCK_USER_TICKETS);
  const [notice, setNotice] = useState<string | null>(null);

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

  const handleDeposit = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    setNotice(`Pro-rata deposit submitted! Minting ~${estimatedShares.toLocaleString()} shares. Warm-up activation: 150 slots (~60s).`);
    setTimeout(() => setNotice(null), 6000);
  };

  const handleWithdraw = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    const newTicket: WithdrawalTicket = {
      id: `wd-${Math.floor(1000 + Math.random() * 9000)}`,
      shares: sharesToWithdraw,
      requestedEpoch: vaultState.epoch,
      eligibleEpoch: vaultState.epoch + 1,
      estimatedSol: Number(withdrawEstSol.toFixed(2)),
      estimatedUsdc: Number(withdrawEstUsdc.toFixed(2)),
      status: 'Pending',
    };
    setTickets([newTicket, ...tickets]);
    setNotice(`Withdrawal ticket queued for Epoch ${vaultState.epoch + 1}.`);
    setTimeout(() => setNotice(null), 6000);
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32 }}>
      <div>
        <h1 className="uni-headline">Active Market-Making Vault</h1>
        <p className="uni-subheadline">
          Deposit SOL and USDC pro-rata. The vault continuously quotes two-sided liquidity on Solana and captures trading fees with bounded risk.
        </p>
      </div>

      {/* Top 4 Stats in reference style */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Total Value Locked</span>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, margin: '8px 0 4px' }}>${vaultState.tvlUsd.toLocaleString()}</p>
          <span className="mono" style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>{vaultState.baseReserve.toLocaleString()} SOL + ${vaultState.quoteReserve.toLocaleString()} USDC</span>
        </div>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Hedged Alpha APY</span>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, color: 'var(--uni-accent1)', margin: '8px 0 4px' }}>+{vaultState.netHedgedApy}%</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Trading fees minus adverse selection</span>
        </div>
        <div className="uni-card">
          <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>LVR Avoided (7-Day)</span>
          <p className="mono" style={{ fontSize: 26, fontWeight: 600, color: 'var(--uni-success)', margin: '8px 0 4px' }}>+${vaultState.lvrAvoided7dUsd.toLocaleString()}</p>
          <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Saved vs passive pool toxic flow</span>
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

              <button type="button" className="uni-main-button accent" onClick={handleDeposit}>
                {!connected ? 'Connect wallet' : 'Deposit pro-rata'}
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

              <button type="button" className="uni-main-button accent" onClick={handleWithdraw}>
                {!connected ? 'Connect wallet' : 'Queue withdrawal for next epoch'}
              </button>
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
            <h3 style={{ fontSize: 16, fontWeight: 535, marginBottom: 12 }}>Active Withdrawal Tickets</h3>
            {tickets.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--uni-surface2)', borderRadius: 14, marginBottom: 8, fontSize: 13 }}>
                <div>
                  <span className="mono" style={{ fontWeight: 600 }}>{t.id}</span>
                  <div style={{ color: 'var(--uni-neutral2)', fontSize: 12 }}>{t.shares.toLocaleString()} shares → {t.estimatedSol} SOL + ${t.estimatedUsdc} USDC</div>
                </div>
                <span className="mono" style={{ color: t.status === 'Ready' ? 'var(--uni-success)' : 'var(--uni-warning)', fontSize: 12 }}>
                  {t.status} (Epoch {t.eligibleEpoch})
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};
