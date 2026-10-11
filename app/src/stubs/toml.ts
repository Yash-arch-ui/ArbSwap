// Browser stub for the `toml` package. It is only pulled in by the Anchor
// *CLI* toolchain (`@coral-xyz/anchor`), not by the on-chain `Program` client
// the dApp uses. Aliasing it here keeps the unused parser out of the browser
// bundle; if any browser code path actually tries to parse TOML it fails loudly.
const unsupported = (): never => {
  throw new Error('toml parsing is not available in the browser build');
};
export const parse = unsupported;
export const stringify = unsupported;
export default { parse, stringify };
