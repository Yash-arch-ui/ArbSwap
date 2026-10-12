/**
 * Integer-safe token amount conversion. Never use JavaScript floating point to
 * determine a transaction amount: parse user input to `bigint` atoms and format
 * atoms back to a decimal string with explicit helpers.
 */

/** Parse a decimal string ("1.5") to atoms (bigint) at `decimals` precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new Error(`invalid amount: "${value}"`);
  }
  const [whole = '', frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal token: "${value}"`);
  }
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

/** Format atoms (bigint) to a fixed-point decimal string. */
export function formatUnits(atoms: bigint, decimals: number, maxFrac = decimals): string {
  const neg = atoms < 0n;
  const abs = neg ? -atoms : atoms;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, Math.max(0, maxFrac));
  fracStr = fracStr.replace(/0+$/, '');
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${out}` : out;
}

/** Safe `Number` for display only (never for transaction amounts). */
export function atomsToDisplayNumber(atoms: bigint, decimals: number): number {
  return Number(formatUnits(atoms, decimals, Math.min(decimals, 9)));
}
