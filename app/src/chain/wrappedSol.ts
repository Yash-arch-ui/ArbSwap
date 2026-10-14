// S2-37/4.2: WSOL wrap/unwrap helpers for the connected wallet.
//
// The vault base mint is native WSOL, so selling SOL requires a funded WSOL ATA.
// These helpers build the instructions (pure, testable) and a send wrapper that
// keeps a fee buffer. They never substitute a keypair for the connected wallet.
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/** Lamports (0.05 SOL) retained so wrap/unwrap never strands the fee payer. */
export const MIN_SOL_FOR_FEES = 50_000_000n;

export function wrappedSolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(NATIVE_MINT, owner);
}

export function assertKeepsFeeBuffer(solLamports: bigint, wrapLamports: bigint): void {
  if (wrapLamports <= 0n) throw new Error('wrap amount must be > 0');
  if (solLamports - wrapLamports < MIN_SOL_FOR_FEES) {
    throw new Error('wrap would leave less than 0.05 SOL for fees');
  }
}

/** Instructions to (idempotently) create the WSOL ATA, fund it, and syncNative. */
export function wrapSolInstructions(
  owner: PublicKey,
  lamports: bigint,
  ataExists: boolean,
): TransactionInstruction[] {
  const ata = wrappedSolAta(owner);
  const ixs: TransactionInstruction[] = [];
  if (!ataExists) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT));
  }
  ixs.push(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: Number(lamports) }),
  );
  ixs.push(createSyncNativeInstruction(ata));
  return ixs;
}

/** Instructions to close the WSOL ATA and return the lamports to the owner. */
export function unwrapSolInstructions(owner: PublicKey): {
  ata: PublicKey;
  instructions: TransactionInstruction[];
} {
  const ata = wrappedSolAta(owner);
  return { ata, instructions: [createCloseAccountInstruction(ata, owner, owner)] };
}

export function buildWrapTransaction(
  owner: PublicKey,
  lamports: bigint,
  ataExists: boolean,
  recentBlockhash: string,
): Transaction {
  return new Transaction({ feePayer: owner, recentBlockhash }).add(
    ...wrapSolInstructions(owner, lamports, ataExists),
  );
}

export function buildUnwrapTransaction(owner: PublicKey, recentBlockhash: string): Transaction {
  return new Transaction({ feePayer: owner, recentBlockhash }).add(...unwrapSolInstructions(owner).instructions);
}

interface SignerWallet {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

export async function wrapSol(
  connection: Connection,
  wallet: SignerWallet,
  lamports: bigint,
): Promise<string> {
  const owner = wallet.publicKey;
  const sol = BigInt(await connection.getBalance(owner));
  assertKeepsFeeBuffer(sol, lamports);
  const ata = wrappedSolAta(owner);
  const exists = (await connection.getAccountInfo(ata)) !== null;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = buildWrapTransaction(owner, lamports, exists, blockhash);
  const signed = await wallet.signTransaction(tx);
  return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
}

export async function unwrapSol(connection: Connection, wallet: SignerWallet): Promise<string> {
  const owner = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = buildUnwrapTransaction(owner, blockhash);
  const signed = await wallet.signTransaction(tx);
  return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
}

export { TOKEN_PROGRAM_ID };
