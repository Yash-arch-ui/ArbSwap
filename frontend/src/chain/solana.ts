import { PublicKey } from '@solana/web3.js';

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

// Anchor Program ID from Anchor.toml & programs/arbswap/src/lib.rs
export const ARBSWAP_PROGRAM_ID = new PublicKey('E8ptkpV626P2neR8v4Q9UCFHoD6AMAH2aTRsEQiNDN3U');

// Well-known devnet & mainnet mint addresses
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export interface ArbSwapConfig {
  programId: PublicKey;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  pythFeedId: string;
}

export const ARBSWAP_CONFIG: ArbSwapConfig = {
  programId: ARBSWAP_PROGRAM_ID,
  cluster: 'devnet',
  pythFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL/USD feed
};
