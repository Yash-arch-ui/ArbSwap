import { useState } from 'react';
import { SolanaWalletProvider } from './chain/WalletProvider';
import { ProtocolProvider } from './context/ProtocolContext';
import { Navbar, type NavTab } from './components/Navbar';
import { Orbs } from './ui/Orbs';
import { OverviewPage } from './pages/OverviewPage';
import { SwapPage } from './pages/SwapPage';
import { VaultPage } from './pages/VaultPage';
import { RiskPage } from './pages/RiskPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import './theme.css';

export function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>('overview');

  return (
    <SolanaWalletProvider>
      <ProtocolProvider>
        <div className="uni">
          <Orbs fixed />
          <Navbar currentTab={currentTab} onSelectTab={setCurrentTab} />

          <main className="uni-main">
            {currentTab === 'overview' && <OverviewPage onNavigate={setCurrentTab} />}
            {currentTab === 'swap' && <SwapPage />}
            {currentTab === 'vault' && <VaultPage />}
            {currentTab === 'risk' && <RiskPage />}
            {currentTab === 'analytics' && <AnalyticsPage />}
          </main>
        </div>
      </ProtocolProvider>
    </SolanaWalletProvider>
  );
}

export default App;
