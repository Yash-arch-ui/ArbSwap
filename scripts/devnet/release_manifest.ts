// S2-22: reproducible release manifest generator. Read-only; writes only a JSON
// record (no secrets, no keys, no secret-bearing URLs).
//
//   npx tsx release_manifest.ts
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";

const ROOT = process.env.ARBSWAP_ROOT ?? "/home/ash10/solana/arbswap";
const ARTIFACT = `${ROOT}/target/deploy/arbswap.so`;
const IDL = `${ROOT}/app/src/idl/arbswap.json`;
const OUT = process.env.ARBSWAP_MANIFEST ?? `${ROOT}/docs/release_manifest.json`;

function sha256(p: string): { size: number; sha256: string } | null {
  try {
    const b = fs.readFileSync(p);
    return { size: b.length, sha256: createHash("sha256").update(b).digest("hex") };
  } catch {
    return null;
  }
}
function cmd(c: string, args: string[]): string | null {
  try {
    return execFileSync(c, args, { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return null;
  }
}

const manifest = {
  generated_by: "scripts/devnet/release_manifest.ts",
  source_commit: cmd("git", ["rev-parse", "HEAD"]),
  program_id: "2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm",
  cluster: "devnet",
  toolchain: {
    rustc: cmd("rustc", ["--version"]),
    cargo_build_sbf: cmd("cargo-build-sbf", ["--version"]),
    anchor: cmd("anchor", ["--version"]),
    node: cmd("node", ["--version"]),
  },
  build_command: "cd vault/program && cargo build-sbf   # + anchor idl build -o target/idl/arbswap.json",
  artifact: sha256(ARTIFACT) ? { path: "target/deploy/arbswap.so", ...sha256(ARTIFACT)! } : { path: "target/deploy/arbswap.so", missing: true },
  idl: sha256(IDL) ? { path: "app/src/idl/arbswap.json", ...sha256(IDL)! } : { path: "app/src/idl/arbswap.json", missing: true },
  account_layouts: {
    quote_state: { legacy_len: 865, current_len: 897, discriminator: "beffae2c13d7259c" },
  },
  required_migration: {
    account: "QuoteState 5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG",
    from_len: 865,
    to_len: 897,
    instruction: "migrate_quote_state(payer, vault, quote_state)",
    permissionless: true,
  },
  expected_post_deploy_checks: [
    "release_preflight.ts -> quote_state.layout == current, ok == true",
    "keeper_inspect.ts -> quote.keeper set after a fresh commit, unattributed == false",
    "two independent keepers can commit and their reward PDAs credit separately",
  ],
  tests: {
    commands: [
      "cargo fmt --all --check",
      "cargo test --workspace",
      "cd scripts/devnet && npx tsx rpc.test.ts",
      "cd scripts/devnet && npx tsx keeper_commit.test.ts",
      "cd app && yarn test && yarn lint && yarn build",
      ".venv/bin/python -m pytest simulation/analytics/tests -q",
    ],
    results_record: "docs/S2_22_RELEASE_READINESS.md",
  },
};

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${OUT}`);
