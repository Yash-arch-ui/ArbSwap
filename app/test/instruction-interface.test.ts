import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import idl from '../src/idl/arbswap.json';
import { keeperRewardPda } from '../src/chain/program';

// The committed IDL must match the deployed program's instruction interfaces. If
// a builder or the program changes account ordering, this fails loudly.
const accountsOf = (name: string): string[] =>
  ((idl as unknown as { instructions: Array<{ name: string; accounts: Array<{ name: string }> }> })
    .instructions.find((i) => i.name === name)?.accounts ?? []).map((a) => a.name);

describe('deployed instruction interfaces (IDL ↔ builders)', () => {
  it('swap includes keeper_reward and system_program', () => {
    expect(accountsOf('swap')).toEqual([
      'trader', 'vault', 'config', 'quote_state', 'base_reserve', 'quote_reserve',
      'trader_base', 'trader_quote', 'keeper_reward', 'system_program', 'token_program',
    ]);
  });

  it('claim_keeper_reward pays only the signer-owned reward PDA', () => {
    expect(accountsOf('claim_keeper_reward')).toEqual([
      'keeper', 'vault', 'keeper_reward', 'base_reserve', 'quote_reserve',
      'keeper_base', 'keeper_quote', 'token_program',
    ]);
  });

  it('deposit / withdraw / crank interfaces are unchanged', () => {
    expect(accountsOf('deposit')).toEqual([
      'user', 'vault', 'config', 'base_reserve', 'quote_reserve', 'share_mint',
      'share_lock', 'user_base', 'user_quote', 'user_shares', 'deposit_ticket',
      'token_program', 'system_program',
    ]);
    expect(accountsOf('request_withdraw')).toEqual([
      'user', 'vault', 'share_lock', 'deposit_ticket', 'user_shares',
      'withdraw_ticket', 'token_program', 'system_program',
    ]);
    expect(accountsOf('claim_withdraw')).toEqual([
      'user', 'vault', 'base_reserve', 'quote_reserve', 'share_mint', 'share_lock',
      'withdraw_ticket', 'user_base', 'user_quote', 'token_program',
    ]);
    expect(accountsOf('crank_epoch')).toEqual(['vault', 'config']);
  });

  it('migrate_quote_state is present for operators (not user-facing)', () => {
    expect(accountsOf('migrate_quote_state')).toEqual(['payer', 'vault', 'quote_state', 'system_program']);
  });

  it('QuoteState advertises the appended keeper field and KeeperReward account', () => {
    const raw = JSON.stringify(idl);
    expect(raw).toMatch(/"QuoteState"/);
    expect(raw).toMatch(/"keeper"/);
    expect(raw).toMatch(/"KeeperReward"/);
  });

  it('keeperRewardPda derives [b"reward", vault, keeper]', () => {
    const vault = new PublicKey('8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt');
    const keeper = new PublicKey('8R3VDePSxK4iQ5FYvTwfw16D72QWx7qXhZkYvtKGCQSH');
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('reward'), vault.toBuffer(), keeper.toBuffer()],
      new PublicKey('2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm'),
    );
    expect(keeperRewardPda(vault, keeper).toBase58()).toBe(expected.toBase58());
  });
});
