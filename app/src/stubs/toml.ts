// Browser stub for the `toml` package. It is only pulled in by the Anchor
// *CLI* toolchain (`@coral-xyz/anchor`), not by the on-chain `Program` client
// the dApp uses. Aliasing it here keeps the unused parser out of the browser
// bundle; if any browser code path actually tries to parse TOML it fails loudly.
//
// `calls()` exposes a live counter so the stub-safety test can prove that no
// client code path (fetch or instruction builder) ever invokes the parser.
const state = { calls: 0 };

const unsupported = (): never => {
  state.calls += 1;
  throw new Error('toml parsing is not available in the browser build');
};

/** Number of times a browser code path invoked the TOML parser (must stay 0). */
export const calls = (): number => state.calls;

export const parse = unsupported;
export const stringify = unsupported;
export default { parse, stringify };
