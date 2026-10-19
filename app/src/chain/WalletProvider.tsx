import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  AlphaWalletAdapter,
  AvanaWalletAdapter,
  BitgetWalletAdapter,
  BitpieWalletAdapter,
  CloverWalletAdapter,
  Coin98WalletAdapter,
  CoinbaseWalletAdapter,
  CoinhubWalletAdapter,
  FractalWalletAdapter,
  HuobiWalletAdapter,
  HyperPayWalletAdapter,
  KrystalWalletAdapter,
  MathWalletAdapter,
  NekoWalletAdapter,
  NightlyWalletAdapter,
  NufiWalletAdapter,
  OntoWalletAdapter,
  PhantomWalletAdapter,
  SafePalWalletAdapter,
  SaifuWalletAdapter,
  SalmonWalletAdapter,
  SkyWalletAdapter,
  SolflareWalletAdapter,
  SolongWalletAdapter,
  SpotWalletAdapter,
  TokenaryWalletAdapter,
  TokenPocketWalletAdapter,
  TrustWalletAdapter,
  XDEFIWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { SOLANA_DEVNET_RPC } from './solana';

// Import standard Solana wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Wallet coverage:
 *  - Wallet Standard wallets (Phantom, Solflare, Backpack, Glow, Brave, Exodus,
 *    Magic Eden, …) are auto-detected by `WalletProvider` itself.
 *  - The explicit adapters below cover legacy/injected wallets that do not
 *    register over Wallet Standard. Adapters only appear when the wallet is
 *    actually present in the browser.
 *  - Config-dependent adapters (WalletConnect, Torus, Ledger, Trezor, Keystone)
 *    are intentionally not instantiated without their required options.
 */
export const SolanaWalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const endpoint = useMemo(() => SOLANA_DEVNET_RPC, []);

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new AlphaWalletAdapter(),
      new AvanaWalletAdapter(),
      new BitgetWalletAdapter(),
      new BitpieWalletAdapter(),
      new CloverWalletAdapter(),
      new Coin98WalletAdapter(),
      new CoinbaseWalletAdapter(),
      new CoinhubWalletAdapter(),
      new FractalWalletAdapter(),
      new HuobiWalletAdapter(),
      new HyperPayWalletAdapter(),
      new KrystalWalletAdapter(),
      new MathWalletAdapter(),
      new NekoWalletAdapter(),
      new NightlyWalletAdapter(),
      new NufiWalletAdapter(),
      new OntoWalletAdapter(),
      new SafePalWalletAdapter(),
      new SaifuWalletAdapter(),
      new SalmonWalletAdapter(),
      new SkyWalletAdapter(),
      new SolongWalletAdapter(),
      new SpotWalletAdapter(),
      new TokenaryWalletAdapter(),
      new TokenPocketWalletAdapter(),
      new TrustWalletAdapter(),
      new XDEFIWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
