import React from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { ArbLogo } from '../ui/Orbs';
import { useProtocol } from '../context/ProtocolContext';

export type NavTab = 'overview' | 'swap' | 'vault' | 'risk' | 'analytics';

interface NavbarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab }) => {
  const { quoteState } = useProtocol();
  const { connected, publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const shortAddress = publicKey 
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : null;

  return (
    <header className="uni-nav">
      <div className="uni-nav-left">
        <div className="uni-brand" onClick={() => onSelectTab('overview')}>
          <ArbLogo />
          <span>ArbSwap</span>
        </div>
        <nav className="uni-nav-links" aria-label="Primary navigation">
          <a 
            href="#overview" 
            className={currentTab === 'overview' ? 'active' : ''} 
            onClick={(e) => { e.preventDefault(); onSelectTab('overview'); }}
          >
            Overview
          </a>
          <a 
            href="#swap" 
            className={currentTab === 'swap' ? 'active' : ''} 
            onClick={(e) => { e.preventDefault(); onSelectTab('swap'); }}
          >
            Swap
          </a>
          <a 
            href="#vault" 
            className={currentTab === 'vault' ? 'active' : ''} 
            onClick={(e) => { e.preventDefault(); onSelectTab('vault'); }}
          >
            Vault
          </a>
          <a 
            href="#risk" 
            className={currentTab === 'risk' ? 'active' : ''} 
            onClick={(e) => { e.preventDefault(); onSelectTab('risk'); }}
          >
            Risk
          </a>
          <a 
            href="#analytics" 
            className={currentTab === 'analytics' ? 'active' : ''} 
            onClick={(e) => { e.preventDefault(); onSelectTab('analytics'); }}
          >
            Analytics
          </a>
        </nav>
      </div>

      <div className="uni-nav-right">
        {/* Live Slot & Quote Heartbeat pill */}
        <div className="uni-cluster-pill" title="Live Solana Slot & Quote Heartbeat">
          <span className="uni-dot" />
          <span>Slot {quoteState.currentSlot}</span>
          <span style={{ color: 'var(--uni-neutral2)', fontSize: 12 }}>v{quoteState.version}</span>
        </div>

        {/* Real Solana Wallet Adapter Button */}
        {connected && shortAddress ? (
          <button 
            type="button" 
            className="uni-account-btn" 
            onClick={() => disconnect()}
            title="Click to disconnect"
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--uni-accent1)' }} />
            <span>{shortAddress}</span>
          </button>
        ) : (
          <button 
            type="button" 
            className="uni-connect" 
            onClick={() => setVisible(true)}
          >
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
};
