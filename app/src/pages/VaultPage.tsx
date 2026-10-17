import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { APP_RPC_FAILOVER } from '../chain/rpcFailover';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useProtocol } from '../context/ProtocolContext';
import {
  requestWithdraw as requestWithdrawOnChain,
  withdrawTicket as deriveWithdrawTicket, expectedDepositShares,
  buildDepositTransaction, buildClaimWithdrawTransaction,
  buildDepositSingleTransaction, buildClaimWithdrawSingleTransaction,
  crankEpoch, simulateSwap, fetchFreshQuote, sendSwapTransaction,
} from '../chain/program';
import { parseUnits, formatUnits } from '../chain/amounts';
import { claimWithdrawState, submitFreshnessReason } from '../chain/gating';
import {
  depositSinglePlan, withdrawSinglePlan, conversionImpactBps, minWithSlippage,
  type SingleSide,
} from '../chain/singleSided';
import { maxGrossInput, quoteCountdown, type LadderLevel } from '../chain/swapMath';
import {
  ACTIVE_VAULT, BASE_MINT, TRANSACTIONS_ENABLED, TRANSACTION_DISABLED_REASON,
  SINGLE_SIDED_ENABLED, SINGLE_SIDED_DISABLED_REASON, explorerTxUrl,
} from '../chain/config';
import { MIN_SOL_FOR_FEES } from '../chain/wrappedSol';
import { NATIVE_MINT } from '@solana/spl-token';
import { ReadOnlyBanner } from '../components/ReadOnlyMode';
import type { Transaction } from '@solana/web3.js';

export const VaultPage: React.FC = () => {
  const {
    vaultState,
    quoteState,
    protocolParams,
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
  // Notice carries an explicit status: a neutral "pending" while a transaction is
  // in flight, and success/cancelled/error only once the chain result is known.
  // This prevents a red failure cross from rendering before the transaction lands.
  type NoticeStatus = 'pending' | 'success' | 'cancelled' | 'error';
  const [notice, setNotice] = useState<{ text: string; status: NoticeStatus } | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  // Task 4.1/4.2: single-sided deposit ("Deposit with") and withdrawal
  // ("Receive as") are opt-in; 0.5% slippage is the documented default.
  const [depositMode, setDepositMode] = useState<'both' | 'single'>('both');
  const [depositInputSide, setDepositInputSide] = useState<SingleSide>('sellBase');
  const [depositSingleAmount, setDepositSingleAmount] = useState<string>('0.1');
  const [warmupAck, setWarmupAck] = useState(false);
  const [withdrawMode, setWithdrawMode] = useState<'both' | 'single'>('both');
  const [withdrawPayoutSide, setWithdrawPayoutSide] = useState<SingleSide>('buyBase');
  // Task 4.1/4.2 default slippage floor (0.5%).
  const slippageBps = 50;
  const [isWorking, setIsWorking] = useState(false);
  // Result of build + simulate, shown before any wallet prompt (Task 4.4).
  const [depPreview, setDepPreview] = useState<{
    tx: Transaction;
    summary: string;
    lines: string[];
  } | null>(null);
  const [claimPreview, setClaimPreview] = useState<{
    tx: Transaction;
    summary: string;
    lines: string[];
  } | null>(null);


  const disabledReason = TRANSACTION_DISABLED_REASON;
  const blocked = (): boolean => {
    if (!TRANSACTIONS_ENABLED) {
      setNotice({ text: disabledReason ?? 'Transactions are disabled in this build.', status: 'error' });
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

  // ---- Task 4.1/4.2: single-sided plans (integer exact, mirrors the program) ----
  const feeBps = protocolParams?.feeBps ?? 1;
  const ladderLevelsFor = (side: SingleSide): LadderLevel[] => {
    try {
      // sellBase converts base (bid ladder); buyBase converts quote (ask ladder).
      const raw = side === 'sellBase' ? quoteState.bidLevelsRaw : quoteState.askLevelsRaw;
      return raw.map((l) => ({ sqrtLo: BigInt(l.sqrtLo), sqrtHi: BigInt(l.sqrtHi), liquidity: BigInt(l.liquidity) }));
    } catch {
      return [];
    }
  };
  const depositInputDecimals = depositInputSide === 'sellBase' ? tokens.SOL.decimals : tokens.USDC.decimals;
  const depositInputSymbol = depositInputSide === 'sellBase' ? tokens.SOL.symbol : tokens.USDC.symbol;
  const depositDustSymbol = depositInputSide === 'sellBase' ? tokens.USDC.symbol : tokens.SOL.symbol;
  const depositSingleAmountAtoms = (() => {
    try { return parseUnits(depositSingleAmount || '0', depositInputDecimals); } catch { return 0n; }
  })();
  const depositLevels = ladderLevelsFor(depositInputSide);
  const singleDeposit = vaultAtoms && quoteState.hasQuote
    ? depositSinglePlan({
        side: depositInputSide,
        amountIn: depositSingleAmountAtoms,
        feeBps,
        baseNet: vaultAtoms.baseNet,
        quoteNet: vaultAtoms.quoteNet,
        totalShares: vaultAtoms.totalShares,
        levels: depositLevels,
      })
    : null;
  const singleDepositMinShares = minWithSlippage(singleDeposit?.shares ?? 0n, slippageBps);
  const singleDepositMinSwapOut = minWithSlippage(singleDeposit?.swapOut ?? 0n, slippageBps);
  const singleDepositImpact = singleDeposit
    ? conversionImpactBps({
        side: depositInputSide,
        swapNet: singleDeposit.swapNet,
        converted: singleDeposit.swapOut,
        pResSqrtQ64: BigInt(quoteState.pResSqrt || '0'),
      })
    : null;
  const depositSwapMax = maxGrossInput(depositLevels, depositInputSide, feeBps);
  const depositCountdown = quoteCountdown(quoteState.expirySlot, quoteState.currentSlot);
  const quoteFresh = quoteState.hasQuote && quoteState.status === 'Fresh';

  const singleDepositReason =
    !SINGLE_SIDED_ENABLED ? SINGLE_SIDED_DISABLED_REASON :
    !TRANSACTIONS_ENABLED ? (TRANSACTION_DISABLED_REASON ?? 'Transactions are disabled in this build.') :
    !vaultInitialized ? 'Vault not initialized.' :
    !quoteFresh ? `Single-sided deposit needs a fresh quote (current: ${quoteState.hasQuote ? quoteState.status : 'Unavailable'}). ${depositCountdown.label}.` :
    depositSingleAmountAtoms <= 0n ? 'Enter an amount.' :
    singleDeposit === null
      ? `No feasible single-sided deposit at this size (internal swap cannot balance).${depositSwapMax > 0n ? ` Max swap depth now: ${formatUnits(depositSwapMax, depositInputDecimals, 6)} ${depositInputSymbol}.` : ''}`
      : !warmupAck ? 'Tick the warm-up notice before depositing.' :
      null;

  const withdrawSharesAtomsForPlan = sharesToWithdrawAtoms > 0n ? sharesToWithdrawAtoms : (withdrawTicket?.shares ?? 0n);
  const singleWithdraw = withdrawTicket && vaultAtoms && quoteState.hasQuote
    ? withdrawSinglePlan({
        side: withdrawPayoutSide,
        shares: withdrawSharesAtomsForPlan,
        totalShares: vaultAtoms.totalShares,
        baseNet: vaultAtoms.baseNet,
        quoteNet: vaultAtoms.quoteNet,
        feeBps,
        levels: ladderLevelsFor(withdrawPayoutSide),
      })
    : null;
  const withdrawPayoutSymbol = withdrawPayoutSide === 'buyBase' ? tokens.SOL.symbol : tokens.USDC.symbol;
  const withdrawPayoutDecimals = withdrawPayoutSide === 'buyBase' ? tokens.SOL.decimals : tokens.USDC.decimals;
  const singleWithdrawMinOut = minWithSlippage(singleWithdraw?.payout ?? 0n, slippageBps);
  const singleWithdrawImpact = singleWithdraw
    ? conversionImpactBps({
        side: withdrawPayoutSide,
        swapNet: singleWithdraw.swapNet,
        converted: singleWithdraw.converted,
        pResSqrtQ64: BigInt(quoteState.pResSqrt || '0'),
      })
    : null;
  const singleWithdrawReason =
    !SINGLE_SIDED_ENABLED ? SINGLE_SIDED_DISABLED_REASON :
    !TRANSACTIONS_ENABLED ? (TRANSACTION_DISABLED_REASON ?? 'Transactions are disabled in this build.') :
    !vaultInitialized ? 'Vault not initialized.' :
    !quoteFresh ? `Single-token claim needs a fresh quote. Quote expired: claim both tokens instead. (${depositCountdown.label})` :
    !claimState.allowed ? claimState.reason :
    singleWithdraw === null ? 'No withdrawal ticket to convert.' :
    singleWithdraw.capacityExceeded ? `Exceeds quoted depth: the conversion leg cannot be filled. Claim both tokens instead.` :
    null;
  const epochSecs = vaultState.epochSlotsRemaining * 0.248;

  const handleDeposit = async () => {
    if (blocked()) return;
    if (isWorking) return;
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setIsWorking(true);
    setNotice(null);
    setDepPreview(null);
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
      const expected = expectedDepositShares({ baseAmount: base, quoteAmount: quote, ...vaultAtoms });
      if (expected <= 0n) throw new Error('deposit too small for the current vault');
      const minShares = minWithSlippage(expected, slippageBps);
      setNotice({ text: 'Simulating deposit before signing…', status: 'pending' });
      const tx = await buildDepositTransaction(connection, wallet, base, quote, minShares);
      const sim = await simulateSwap(connection, tx);
      if (!sim.ok) throw new Error(sim.reason ?? 'The transaction simulation failed.');
      setNotice(null);
      setDepPreview({
        tx,
        summary: `Deposit pro-rata: ${depositSol} SOL + ${depositUsdc} USDC`,
        lines: [
          `Instruction: deposit (both tokens)`,
          `Base in: ${depositSol} ${tokens.SOL.symbol} → vault base reserve`,
          `Quote in: ${depositUsdc} ${tokens.USDC.symbol} → vault quote reserve`,
          `Expected shares: ~${formatUnits(expected, ACTIVE_VAULT.shareDecimals, 6)}`,
          `Minimum shares (${(slippageBps / 100).toFixed(2)}%): ${formatUnits(minShares, ACTIVE_VAULT.shareDecimals, 6)}`,
          `Shares mint to: your share account`,
        ],
      });
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      const human = cancelled
        ? 'Deposit signing was cancelled by user.'
        : `Deposit failed: ${msg.slice(0, 160)}`;
      setNotice({ text: human, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  // Task 4.1: single-sided deposit preview (build + simulate, no signing).
  const handleDepositSinglePreview = async () => {
    if (!SINGLE_SIDED_ENABLED) { setNotice({ text: SINGLE_SIDED_DISABLED_REASON ?? 'Single-sided is disabled.', status: 'error' }); return; }
    if (isWorking) return;
    if (!connected || !publicKey || !wallet) { setVisible(true); return; }
    if (singleDepositReason) { setNotice({ text: singleDepositReason, status: 'error' }); return; }
    setIsWorking(true);
    setNotice(null);
    setDepPreview(null);
    try {
      if (!vaultAtoms) throw new Error('vault state not loaded yet');
      const fresh = await fetchFreshQuote(connection);
      const freshReason = submitFreshnessReason(fresh);
      if (!fresh || freshReason) throw new Error(freshReason ?? 'A fresh quote is required.');
      const levels: LadderLevel[] = (depositInputSide === 'sellBase' ? fresh.bidLevels : fresh.askLevels).map((l) => ({
        sqrtLo: BigInt(l.sqrtLo.toString()), sqrtHi: BigInt(l.sqrtHi.toString()), liquidity: BigInt(l.liquidity.toString()),
      }));
      const plan = depositSinglePlan({
        side: depositInputSide, amountIn: depositSingleAmountAtoms, feeBps,
        baseNet: vaultAtoms.baseNet, quoteNet: vaultAtoms.quoteNet, totalShares: vaultAtoms.totalShares, levels,
      });
      if (!plan) throw new Error('No feasible single-sided deposit at this size.');
      const minShares = minWithSlippage(plan.shares, slippageBps);
      const minSwapOut = minWithSlippage(plan.swapOut, slippageBps);
      const tx = await buildDepositSingleTransaction(connection, wallet, depositInputSide, depositSingleAmountAtoms, minShares, minSwapOut);
      const sim = await simulateSwap(connection, tx);
      if (!sim.ok) throw new Error(sim.reason ?? 'The transaction simulation failed.');
      setNotice(null);
      setDepPreview({
        tx,
        summary: `Deposit single token: ${depositSingleAmount} ${depositInputSymbol}`,
        lines: [
          `Instruction: deposit_single (${depositInputSide})`,
          `Input in: ${depositSingleAmount} ${depositInputSymbol} → vault reserves`,
          `Swap portion: ${formatUnits(plan.swapIn, depositInputDecimals, 6)} ${depositInputSymbol} (fee ${formatUnits(plan.fee, depositInputDecimals, 6)})`,
          `Internal swap out: ~${formatUnits(plan.swapOut, depositInputSide === 'sellBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6)} ${depositDustSymbol}`,
          `Deposited: ${formatUnits(plan.baseDeposited, tokens.SOL.decimals, 6)} SOL + ${formatUnits(plan.quoteDeposited, tokens.USDC.decimals, 6)} USDC`,
          `Expected shares: ~${formatUnits(plan.shares, ACTIVE_VAULT.shareDecimals, 6)}`,
          `Min swap out (${(slippageBps / 100).toFixed(2)}%): ${formatUnits(minSwapOut, depositInputSide === 'sellBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6)}`,
          `Min shares: ${formatUnits(minShares, ACTIVE_VAULT.shareDecimals, 6)}`,
        ],
      });
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      setNotice({ text: cancelled ? 'Deposit signing was cancelled by user.' : `Single-sided deposit failed: ${msg.slice(0, 160)}`, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  const runDepositConfirm = async () => {
    if (!depPreview || !wallet) return;
    if (isWorking) return;
    setIsWorking(true);
    setNotice(null);
    try {
      // The preview was built and simulated earlier, so the quote may have
      // expired or the blockhash may have aged while it sat on screen. Never
      // resubmit a stale transaction: for the single-sided path (which trades
      // against the committed ladder) re-read and re-validate the quote, and in
      // all cases refresh the blockhash against the live cluster.
      if (depositMode === 'single') {
        const fresh = await fetchFreshQuote(connection);
        const freshReason = submitFreshnessReason(fresh);
        if (freshReason) {
          setNotice({ text: `${freshReason} The prepared deposit was discarded.`, status: 'error' });
          setDepPreview(null);
          return;
        }
      }
      depPreview.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const signature = await sendSwapTransaction(connection, wallet, depPreview.tx);
      setNotice({ text: `Deposit confirmed ${signature.slice(0, 8)}... Shares activate after warm-up. ${explorerTxUrl(signature)}`, status: 'success' });
      setDepPreview(null);
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      setNotice({ text: cancelled ? 'Deposit signing was cancelled by user.' : `Deposit failed: ${msg.slice(0, 160)}`, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  const handleWithdraw = async () => {
    if (blocked()) return;
    if (isWorking) return;
    if (!connected || !publicKey || !wallet) {
      setVisible(true);
      return;
    }
    setIsWorking(true);
    setNotice({ text: 'Queueing withdrawal… Awaiting wallet signature and confirmation.', status: 'pending' });
    try {
      const signature = await requestWithdrawOnChain(connection, wallet, sharesToWithdrawAtoms);
      setNotice({ text: `Withdrawal queued ${signature.slice(0, 8)}… for Epoch ${vaultState.epoch + 1}.`, status: 'success' });
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      const human = cancelled
        ? 'Withdrawal queue signing was cancelled by user.'
        : `Withdraw request failed: ${msg.slice(0, 160)}`;
      setNotice({ text: human, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  const handleCrank = async () => {
    if (blocked()) return;
    if (isWorking) return;
    if (!connected || !publicKey || !wallet) { setVisible(true); return; }
    setIsWorking(true);
    setNotice({ text: 'Advancing epoch (crank)… Awaiting wallet signature and confirmation.', status: 'pending' });
    try {
      const signature = await crankEpoch(connection, wallet);
      setNotice({ text: `Epoch cranked ${signature.slice(0, 8)}... ${explorerTxUrl(signature)}`, status: 'success' });
      await refreshProtocol();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      setNotice({ text: cancelled ? 'Crank signing was cancelled by user.' : `Crank failed: ${msg.slice(0, 160)}`, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  // Build + simulate the claim (both-token or single-token), never signs here.
  const handleClaimPreview = async () => {
    if (blocked()) return;
    if (isWorking || isClaiming) return;
    if (!connected || !publicKey || !wallet) { setVisible(true); return; }
    if (!claimState.allowed) { setNotice({ text: claimState.reason, status: 'error' }); return; }
    setIsWorking(true);
    setNotice(null);
    setClaimPreview(null);
    try {
      let tx: Transaction;
      let summary: string;
      let lines: string[];
      if (withdrawMode === 'single') {
        if (!SINGLE_SIDED_ENABLED) { setNotice({ text: SINGLE_SIDED_DISABLED_REASON ?? 'Single-sided is disabled.', status: 'error' }); return; }
        if (singleWithdrawReason) { setNotice({ text: singleWithdrawReason, status: 'error' }); return; }
        if (!vaultAtoms) throw new Error('vault state not loaded yet');
        const fresh = await fetchFreshQuote(connection);
        const freshReason = submitFreshnessReason(fresh);
        if (!fresh || freshReason) throw new Error(`${freshReason ?? 'A fresh quote is required.'} Claim both tokens instead.`);
        const levels: LadderLevel[] = (withdrawPayoutSide === 'buyBase' ? fresh.askLevels : fresh.bidLevels).map((l) => ({
          sqrtLo: BigInt(l.sqrtLo.toString()), sqrtHi: BigInt(l.sqrtHi.toString()), liquidity: BigInt(l.liquidity.toString()),
        }));
        const plan = withdrawSinglePlan({
          side: withdrawPayoutSide, shares: withdrawSharesAtomsForPlan, totalShares: vaultAtoms.totalShares,
          baseNet: vaultAtoms.baseNet, quoteNet: vaultAtoms.quoteNet, feeBps, levels,
        });
        if (plan.capacityExceeded) throw new Error('Exceeds quoted depth: claim both tokens instead.');
        const minOut = minWithSlippage(plan.payout, slippageBps);
        tx = await buildClaimWithdrawSingleTransaction(connection, wallet, withdrawPayoutSide, minOut);
        summary = `Claim withdrawal as one token: ${withdrawPayoutSymbol}`;
        lines = [
          `Instruction: claim_withdraw_single (${withdrawPayoutSide})`,
          `Shares redeemed: ${withdrawSharesAtomsForPlan.toString()} (atoms)`,
          `Base leg out: ${formatUnits(plan.baseOut, tokens.SOL.decimals, 6)} SOL`,
          `Quote leg out: ${formatUnits(plan.quoteOut, tokens.USDC.decimals, 6)} USDC`,
          `Converted leg: ${formatUnits(plan.converted, withdrawPayoutDecimals, 6)} ${withdrawPayoutSymbol} (fee ${formatUnits(plan.fee, withdrawPayoutSide === 'buyBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6)})`,
          `Expected payout: ~${formatUnits(plan.payout, withdrawPayoutDecimals, 6)} ${withdrawPayoutSymbol}`,
          `Minimum out (${(slippageBps / 100).toFixed(2)}%): ${formatUnits(minOut, withdrawPayoutDecimals, 6)} ${withdrawPayoutSymbol}`,
          `Payout to: your ${withdrawPayoutSymbol} account`,
        ];
      } else {
        tx = await buildClaimWithdrawTransaction(connection, wallet);
        const estSol = withdrawSharesAtomsForPlan > 0n && vaultAtoms
          ? (withdrawSharesAtomsForPlan * vaultAtoms.baseNet) / vaultAtoms.totalShares : 0n;
        const estQuote = withdrawSharesAtomsForPlan > 0n && vaultAtoms
          ? (withdrawSharesAtomsForPlan * vaultAtoms.quoteNet) / vaultAtoms.totalShares : 0n;
        summary = 'Claim withdrawal as both tokens (pro-rata)';
        lines = [
          `Instruction: claim_withdraw (both tokens)`,
          `Shares redeemed: ${withdrawSharesAtomsForPlan.toString()} (atoms)`,
          `Estimated base out: ${formatUnits(estSol, tokens.SOL.decimals, 6)} SOL`,
          `Estimated quote out: ${formatUnits(estQuote, tokens.USDC.decimals, 6)} USDC`,
          `Payout to: your SOL and USDC accounts`,
        ];
      }
      const sim = await simulateSwap(connection, tx);
      if (!sim.ok) throw new Error(sim.reason ?? 'The transaction simulation failed.');
      setNotice(null);
      setClaimPreview({ tx, summary, lines });
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      setNotice({ text: cancelled ? 'Claim signing was cancelled by user.' : `Claim preparation failed: ${msg.slice(0, 160)}`, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsWorking(false);
    }
  };

  const handleClaimConfirm = async () => {
    if (!claimPreview || !wallet) return;
    if (isClaiming) return;
    setIsClaiming(true);
    setNotice(null);
    try {
      // Re-validate against a freshly read quote immediately before signing.
      // Only the single-sided path converts against the committed ladder and
      // requires a fresh quote; two-sided claims settle from live reserves.
      if (withdrawMode === 'single') {
        const fresh = await fetchFreshQuote(connection);
        const freshReason = submitFreshnessReason(fresh);
        if (freshReason) {
          // A quote that expired between preview and confirm fails closed; never
          // resubmit the stale transaction.
          setNotice({ text: `${freshReason} The prepared claim was discarded.`, status: 'error' });
          setClaimPreview(null);
          return;
        }
      }
      claimPreview.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const signature = await sendSwapTransaction(connection, wallet, claimPreview.tx);
      setNotice({ text: `Claim confirmed ${signature.slice(0, 8)}... ${explorerTxUrl(signature)}`, status: 'success' });
      setClaimPreview(null);
      await refreshProtocol();
      await refreshBalances();
    } catch (error) {
      const msg = (error as Error).message ?? 'unknown error';
      const cancelled = /user rejected|rejected the request|declined|cancel/i.test(msg);
      setNotice({ text: cancelled ? 'Claim signing was cancelled by user.' : `Claim failed: ${msg.slice(0, 160)}`, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      setIsClaiming(false);
    }
  };

  const setWithdrawPercent = (pct: number) => {
    if (shareBalanceAtoms === null) return;
    const next = (shareBalanceAtoms * BigInt(pct)) / 100n;
    setWithdrawShares(formatUnits(next, ACTIVE_VAULT.shareDecimals));
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '36px 20px 80px', display: 'flex', flexDirection: 'column', gap: 32 }}>
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
            <span style={{ fontSize: 13, color: 'var(--uni-neutral2)' }}>Hedged Alpha Return</span>
            <span style={{ fontSize: 10, color: 'var(--uni-accent1)', background: 'rgba(0,229,176,0.1)', padding: '2px 6px', borderRadius: 4 }}>Model Est.</span>
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
        <div className="uni-card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* High-Contrast Segmented Tab Controls */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 16,
            padding: 5,
            gap: 6,
          }}>
            <button 
              type="button" 
              onClick={() => { setActiveTab('deposit'); setNotice(null); }}
              style={{
                padding: '12px 18px',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                background: activeTab === 'deposit' 
                  ? 'linear-gradient(135deg, rgba(0, 229, 176, 0.2), rgba(0, 229, 176, 0.08))' 
                  : 'transparent',
                color: activeTab === 'deposit' ? '#00e5b0' : 'var(--uni-neutral2)',
                border: activeTab === 'deposit' 
                  ? '1px solid rgba(0, 229, 176, 0.4)' 
                  : '1px solid transparent',
                boxShadow: activeTab === 'deposit' 
                  ? '0 4px 16px rgba(0, 229, 176, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.15)' 
                  : 'none',
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: activeTab === 'deposit' ? '#00e5b0' : 'rgba(255, 255, 255, 0.25)',
                boxShadow: activeTab === 'deposit' ? '0 0 8px #00e5b0' : 'none',
              }} />
              <span>Deposit (Pro-Rata)</span>
            </button>
            <button 
              type="button" 
              onClick={() => { setActiveTab('withdraw'); setNotice(null); }}
              style={{
                padding: '12px 18px',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                background: activeTab === 'withdraw' 
                  ? 'linear-gradient(135deg, rgba(0, 229, 176, 0.2), rgba(0, 229, 176, 0.08))' 
                  : 'transparent',
                color: activeTab === 'withdraw' ? '#00e5b0' : 'var(--uni-neutral2)',
                border: activeTab === 'withdraw' 
                  ? '1px solid rgba(0, 229, 176, 0.4)' 
                  : '1px solid transparent',
                boxShadow: activeTab === 'withdraw' 
                  ? '0 4px 16px rgba(0, 229, 176, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.15)' 
                  : 'none',
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: activeTab === 'withdraw' ? '#00e5b0' : 'rgba(255, 255, 255, 0.25)',
                boxShadow: activeTab === 'withdraw' ? '0 0 8px #00e5b0' : 'none',
              }} />
              <span>Withdraw (Epoch Queue)</span>
            </button>
          </div>

          {activeTab === 'deposit' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Deposit with:</span>
                <button type="button" data-testid="deposit-mode-both" className={`uni-max ${depositMode === 'both' ? 'active' : ''}`} onClick={() => { setDepositMode('both'); setDepPreview(null); }}>Both tokens</button>
                <button type="button" data-testid="deposit-mode-single" className={`uni-max ${depositMode === 'single' ? 'active' : ''}`} onClick={() => { setDepositMode('single'); setDepPreview(null); }} disabled={!SINGLE_SIDED_ENABLED} title={SINGLE_SIDED_DISABLED_REASON ?? undefined}>Single token</button>
              </div>

              {depositMode === 'both' ? (
                <>
                  <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                    <strong>Pro-Rata Two-Token Accounting (D-05):</strong> Deposits contribute both SOL and USDC proportional to current pool reserves. No oracle is used in share calculation.
                    <br />
                    <span style={{ color: 'var(--uni-accent1)' }}>Your SOL is auto-wrapped to WSOL in the same transaction. No manual wrap needed.</span>
                  </p>

                  <div className="uni-panel uni-panel-sell">
                    <span className="uni-panel-label">SOL Deposit</span>
                    <div className="uni-panel-row">
                      <input
                        className="uni-amount mono"
                        value={depositSol}
                        onChange={(e) => {
                          setDepositSol(e.target.value);
                          setDepPreview(null);
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
                          setDepPreview(null);
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

                  <button type="button" className="uni-main-button accent" onClick={handleDeposit} disabled={!TRANSACTIONS_ENABLED || !vaultInitialized || isWorking}>
                    {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : !vaultInitialized ? 'Vault not initialized' : !connected ? 'Connect wallet' : isWorking ? 'Simulating…' : 'Preview deposit pro-rata'}
                  </button>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                    <strong>Single-Token Deposit:</strong> Deposit only one token. The vault converts part of it against its own committed ladder at the current committed quote and deposits the balanced remainder, so no second token is needed. This is a trade at the committed quote, so it shares the same stale-quote exposure as a swap; it is bounded by the anchor-deviation bound, the per-window flow cap and the realized-edge breaker. The program charges its normal fee on the swapped portion; any unswapped dust of the other token stays in your wallet.
                  </p>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Token:</span>
                    <button type="button" data-testid="deposit-side-sol" className={`uni-max ${depositInputSide === 'sellBase' ? 'active' : ''}`} onClick={() => { setDepositInputSide('sellBase'); setDepPreview(null); }}>SOL</button>
                    <button type="button" data-testid="deposit-side-usdc" className={`uni-max ${depositInputSide === 'buyBase' ? 'active' : ''}`} onClick={() => { setDepositInputSide('buyBase'); setDepPreview(null); }}>USDC</button>
                  </div>

                  <div className="uni-panel uni-panel-sell">
                    <span className="uni-panel-label">{depositInputSymbol} Deposit</span>
                    <div className="uni-panel-row">
                      <input className="uni-amount mono" value={depositSingleAmount} onChange={(e) => { setDepositSingleAmount(e.target.value); setDepPreview(null); }} />
                      <div className="uni-token-pill">
                        {(depositInputSide === 'sellBase' ? tokens.SOL.logo : tokens.USDC.logo) && <img src={depositInputSide === 'sellBase' ? tokens.SOL.logo : tokens.USDC.logo} alt={depositInputSymbol} />}
                        <span>{depositInputSymbol}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Swap portion:</span>
                      <span className="mono">{singleDeposit ? `${formatUnits(singleDeposit.swapIn, depositInputDecimals, 6)} ${depositInputSymbol}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Internal swap out:</span>
                      <span className="mono">{singleDeposit ? `~${formatUnits(singleDeposit.swapOut, depositInputSide === 'sellBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6)} ${depositDustSymbol}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Fee (on swap portion):</span>
                      <span className="mono">{singleDeposit ? `${formatUnits(singleDeposit.fee, depositInputDecimals, 6)} ${depositInputSymbol}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Price impact (vs reservation mid):</span>
                      <span className="mono">{singleDepositImpact === null ? '—' : `${(singleDepositImpact / 100).toFixed(2)}%`}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Expected shares:</span>
                      <span className="mono" style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>{singleDeposit ? `~${formatUnits(singleDeposit.shares, ACTIVE_VAULT.shareDecimals, 6)}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Min shares ({slippageBps / 100}%):</span>
                      <span className="mono">{singleDeposit ? formatUnits(singleDepositMinShares, ACTIVE_VAULT.shareDecimals, 6) : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Min swap out ({slippageBps / 100}%):</span>
                      <span className="mono">{singleDeposit ? formatUnits(singleDepositMinSwapOut, depositInputSide === 'sellBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6) : '—'}</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: quoteFresh ? 'var(--uni-success)' : 'var(--uni-warning)' }} data-testid="deposit-freshness">
                    Quote: {depositCountdown.label}
                  </div>

                  <label style={{ fontSize: 12, color: 'var(--uni-neutral2)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" data-testid="warmup-ack" checked={warmupAck} onChange={(e) => setWarmupAck(e.target.checked)} />
                    <span>I understand minted shares activate only after the {vaultState.warmupSlots}-slot warm-up (top-ups included); they cannot be withdrawn before then.</span>
                  </label>

                  {singleDepositReason && (
                    <div style={{ fontSize: 12, color: 'var(--uni-warning)' }} role="status" data-testid="deposit-single-reason">{singleDepositReason}</div>
                  )}

                  <button type="button" className="uni-main-button accent" onClick={handleDepositSinglePreview} disabled={!!singleDepositReason || isWorking} data-testid="deposit-single-button">
                    {!SINGLE_SIDED_ENABLED ? 'Single-sided disabled' : !connected ? 'Connect wallet' : isWorking ? 'Simulating…' : 'Preview single-token deposit'}
                  </button>
                </>
              )}

              {depPreview && (
                <div className="uni-card" data-testid="deposit-preview" role="status" style={{ borderColor: 'var(--uni-accent1)' }}>
                  <strong>Transaction preview (simulated).</strong>
                  <p style={{ margin: '6px 0', fontSize: 13 }}>{depPreview.summary}</p>
                  <ul style={{ margin: '6px 0 10px 18px', fontSize: 12, lineHeight: 1.7, color: 'var(--uni-neutral2)' }}>
                    {depPreview.lines.map((l) => <li key={l} className="mono">{l}</li>)}
                  </ul>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="uni-main-button accent" onClick={runDepositConfirm} disabled={isWorking}>Confirm &amp; sign in wallet</button>
                    <button type="button" className="uni-max" onClick={() => setDepPreview(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                <strong>Epoch Queue (M10):</strong> Withdrawals request in Epoch {vaultState.epoch} and settle in Epoch {vaultState.epoch + 1}, settling in ~{vaultState.epochSlotsRemaining} slots (~{epochSecs.toFixed(1)}s), pro-rata against actual net reserves to prevent sandwich attacks.
              </p>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Receive as:</span>
                <button type="button" data-testid="withdraw-mode-both" className={`uni-max ${withdrawMode === 'both' ? 'active' : ''}`} onClick={() => { setWithdrawMode('both'); setClaimPreview(null); }}>Both tokens</button>
                <button type="button" data-testid="withdraw-mode-single" className={`uni-max ${withdrawMode === 'single' ? 'active' : ''}`} onClick={() => { setWithdrawMode('single'); setClaimPreview(null); }} disabled={!SINGLE_SIDED_ENABLED} title={SINGLE_SIDED_DISABLED_REASON ?? undefined}>One token</button>
              </div>

              <div className="uni-panel uni-panel-sell">
                <span className="uni-panel-label">Shares to Redeem</span>
                <div className="uni-panel-row">
                  <input
                    className="uni-amount mono"
                    value={withdrawShares}
                    onChange={(e) => { setWithdrawShares(e.target.value); setClaimPreview(null); }}
                  />
                  <button type="button" className="uni-max" onClick={() => setWithdrawShares(vaultState.userShares.toString())}>Max</button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {[25, 50, 75, 100].map((pct) => (
                    <button key={pct} type="button" className="uni-max" data-testid={`withdraw-pct-${pct}`} onClick={() => setWithdrawPercent(pct)}>{pct}%</button>
                  ))}
                </div>
              </div>

              {withdrawMode === 'both' ? (
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
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--uni-neutral2)', lineHeight: 1.6 }}>
                    <strong>One-Token Withdrawal:</strong> Exit to a single token. The vault converts the unwanted leg against its own committed ladder at the current committed quote, so it shares the same stale-quote exposure as a swap. A fresh quote is required; if the quote has expired, claim both tokens instead.
                  </p>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--uni-neutral2)' }}>Token:</span>
                    <button type="button" data-testid="withdraw-payout-sol" className={`uni-max ${withdrawPayoutSide === 'buyBase' ? 'active' : ''}`} onClick={() => { setWithdrawPayoutSide('buyBase'); setClaimPreview(null); }}>SOL</button>
                    <button type="button" data-testid="withdraw-payout-usdc" className={`uni-max ${withdrawPayoutSide === 'sellBase' ? 'active' : ''}`} onClick={() => { setWithdrawPayoutSide('sellBase'); setClaimPreview(null); }}>USDC</button>
                  </div>
                  <div style={{ padding: '12px 16px', background: 'var(--uni-surface2)', borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Base leg:</span>
                      <span className="mono">{singleWithdraw ? `${formatUnits(singleWithdraw.baseOut, tokens.SOL.decimals, 6)} SOL` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Quote leg:</span>
                      <span className="mono">{singleWithdraw ? `${formatUnits(singleWithdraw.quoteOut, tokens.USDC.decimals, 6)} USDC` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Converted leg:</span>
                      <span className="mono">{singleWithdraw ? `~${formatUnits(singleWithdraw.converted, withdrawPayoutDecimals, 6)} ${withdrawPayoutSymbol}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Fee (on converted leg):</span>
                      <span className="mono">{singleWithdraw ? formatUnits(singleWithdraw.fee, withdrawPayoutSide === 'buyBase' ? tokens.USDC.decimals : tokens.SOL.decimals, 6) : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Price impact (vs reservation mid):</span>
                      <span className="mono">{singleWithdrawImpact === null ? '—' : `${(singleWithdrawImpact / 100).toFixed(2)}%`}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Expected payout:</span>
                      <span className="mono" style={{ color: 'var(--uni-accent1)', fontWeight: 600 }}>{singleWithdraw ? `~${formatUnits(singleWithdraw.payout, withdrawPayoutDecimals, 6)} ${withdrawPayoutSymbol}` : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--uni-neutral2)' }}>Min out ({slippageBps / 100}%):</span>
                      <span className="mono">{singleWithdraw ? formatUnits(singleWithdrawMinOut, withdrawPayoutDecimals, 6) : '—'}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: quoteFresh ? 'var(--uni-success)' : 'var(--uni-warning)' }} data-testid="withdraw-freshness">
                    Quote: {depositCountdown.label}
                    {!quoteFresh && ' Quote expired: claim both tokens instead.'}
                  </div>
                </>
              )}

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
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className={`uni-main-button ${claimState.allowed && TRANSACTIONS_ENABLED && !(withdrawMode === 'single' && singleWithdrawReason) ? 'accent' : 'disabled'}`}
                    onClick={handleClaimPreview}
                    disabled={!TRANSACTIONS_ENABLED || !claimState.allowed || isWorking || isClaiming || (withdrawMode === 'single' && !!singleWithdrawReason)}
                    data-testid="claim-button"
                  >
                    {!TRANSACTIONS_ENABLED ? 'Transactions disabled' : isWorking ? 'Simulating…' : claimState.allowed ? (withdrawMode === 'single' ? 'Preview one-token claim' : 'Preview claim') : 'Claim unavailable'}
                  </button>
                  <button type="button" className="uni-max" onClick={handleCrank} disabled={!TRANSACTIONS_ENABLED || !connected} title="Advance the epoch once its slots have elapsed, enabling settled claims">Crank epoch</button>
                </div>
                {withdrawMode === 'single' && singleWithdrawReason && (
                  <div style={{ fontSize: 12, color: 'var(--uni-warning)' }} role="status" data-testid="claim-single-reason">{singleWithdrawReason}</div>
                )}
              </div>

              {claimPreview && (
                <div className="uni-card" data-testid="claim-preview" role="status" style={{ borderColor: 'var(--uni-accent1)' }}>
                  <strong>Transaction preview (simulated).</strong>
                  <p style={{ margin: '6px 0', fontSize: 13 }}>{claimPreview.summary}</p>
                  <ul style={{ margin: '6px 0 10px 18px', fontSize: 12, lineHeight: 1.7, color: 'var(--uni-neutral2)' }}>
                    {claimPreview.lines.map((l) => <li key={l} className="mono">{l}</li>)}
                  </ul>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="uni-main-button accent" onClick={handleClaimConfirm} disabled={isClaiming}>{isClaiming ? 'Claiming…' : 'Confirm & sign in wallet'}</button>
                    <button type="button" className="uni-max" onClick={() => setClaimPreview(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {notice && (
            <div
              className={`vault-status-card ${notice.status}`}
              style={{
                marginTop: 14,
                padding: '12px 16px',
                borderRadius: 12,
                border:
                  notice.status === 'success'
                    ? '1px solid rgba(0, 229, 176, 0.4)'
                    : notice.status === 'cancelled'
                    ? '1px solid rgba(255, 170, 0, 0.4)'
                    : notice.status === 'pending'
                    ? '1px solid rgba(120, 170, 255, 0.4)'
                    : '1px solid rgba(255, 80, 80, 0.4)',
                background:
                  notice.status === 'success'
                    ? 'rgba(0, 229, 176, 0.08)'
                    : notice.status === 'cancelled'
                    ? 'rgba(255, 170, 0, 0.08)'
                    : notice.status === 'pending'
                    ? 'rgba(120, 170, 255, 0.08)'
                    : 'rgba(255, 80, 80, 0.08)',
              }}
              role={notice.status === 'success' || notice.status === 'pending' ? 'status' : 'alert'}
              aria-live={notice.status === 'pending' ? 'polite' : 'assertive'}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: 600,
                fontSize: 13,
                color:
                  notice.status === 'success'
                    ? 'var(--uni-success, #00e5b0)'
                    : notice.status === 'cancelled'
                    ? 'var(--uni-warning, #f5a623)'
                    : notice.status === 'pending'
                    ? 'var(--uni-accent1, #5b8def)'
                    : '#ff5050',
                marginBottom: 4,
              }}>
                <span>
                  {notice.status === 'success'
                    ? '✓ Operation Confirmed'
                    : notice.status === 'cancelled'
                    ? '✕ Request Cancelled'
                    : notice.status === 'pending'
                    ? '◌ Submitting…'
                    : '✕ Request Failed'}
                </span>
                <span style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'rgba(255, 255, 255, 0.1)',
                  fontWeight: 500,
                }}>
                  {notice.status === 'success'
                    ? 'On-Chain Devnet'
                    : notice.status === 'cancelled'
                    ? 'Wallet Notice'
                    : notice.status === 'pending'
                    ? 'In Flight'
                    : 'Notice'}
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
                Wallet WSOL (wrapped):{' '}
                <strong className="mono" style={{ color: 'var(--uni-neutral1)' }}>
                  {!publicKey ? 'connect a wallet' : `${tokens.SOL.balance} ${tokens.SOL.symbol}`}
                </strong>{' '}
                <span style={{ color: 'var(--uni-neutral3)' }}>
                  · native SOL for fees: {!publicKey ? '—' : walletAtoms ? (Number(walletAtoms.sol) / 1e9).toFixed(4) : '…'}
                </span>
              </div>
              <div style={{ color: 'var(--uni-neutral3)', fontSize: 12 }}>
                Native Devnet SOL cannot be used directly as an SPL token. Deposits auto-wrap native SOL → WSOL in the same transaction; the wrapped WSOL balance above is what the vault uses.
              </div>
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
