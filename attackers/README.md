# Attacker bots (adversarial testing, E7)

Status: skeleton (P5). Planned bots per Build Plan §8.1/§10 (E7):

1. **Stale-feed replay** — feed delayed/wrong oracle data, check spread widening + expiry.
2. **Bad-tick injection** — outlier print, check confidence bounds + breaker.
3. **Sandwich bot** — sandwich the vault's swaps; verify `min_out`, size caps,
   and the documented use of private/bundle submission.
4. **Phantom-liquidity bot** — deposit before end of block, withdraw after (0x pattern);
   verify warm-up + epoch queue neutralize it.
5. **Keeper-down test** — kill the keeper; verify quotes expire and fills stop safely.
6. **Adaptive toxic-flow bot** — learns the public rules and probes for residual edge;
   verify spread floor + throttle + expiry contain it.
7. **Sandwich-around-oracle-update bot** — new attack class from the OP-AMM literature
   (arXiv:2609.33799, see docs/ASSUMPTIONS.md A-06).

Gate (P5): every attack fails or is contained, and is documented.
