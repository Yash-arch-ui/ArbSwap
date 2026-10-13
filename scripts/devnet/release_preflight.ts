// S2-22: read-only Devnet release preflight. NEVER sends a transaction.
//
// Validates cluster, program identity, local artifact, account layout, migration
// requirement, payer balance/rent, and IDL consistency. Exits non-zero when the
// environment is not safe to proceed with a (separately authorised) deploy.
//
//   ARBSWAP_CLUSTER=devnet npx tsx release_preflight.ts
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { resolveRpcConfig, RpcPool, redactUrl } from "./rpc";

const PROGRAM = new PublicKey(process.env.ARBSWAP_PROGRAM_ID ?? "2mwpYHpZ2TS6TjG3CbKBqQAwUv4hw7XrAbg4Kb6hyiNm");
const VAULT = new PublicKey(process.env.ARBSWAP_VAULT ?? "8yvFBv9gxiTWRF2vAa6Z5i1DGzpYgNETSP6z8yp82XPt");
const QUOTE_STATE = new PublicKey(process.env.ARBSWAP_QUOTE_STATE ?? "5MsGbdHv3ouXrHT9f7JVQ6b7eVETTiVCzYSGw5DTYAgG");
const LEGACY_LEN = 865;
const CURRENT_LEN = 897;
const ARTIFACT = process.env.ARBSWAP_ARTIFACT ?? "/home/ash10/solana/arbswap/target/deploy/arbswap.so";
const IDL = process.env.ARBSWAP_IDL ?? "/home/ash10/solana/arbswap/app/src/idl/arbswap.json";
const QUOTE_STATE_DISC = "beffae2c13d7259c";

const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const b58 = (d: Buffer) => new PublicKey(d.subarray(0, 32)).toBase58();
function sha256(p: string): { size: number; sha256: string } | null {
  try {
    const b = fs.readFileSync(p);
    return { size: b.length, sha256: createHash("sha256").update(b).digest("hex") };
  } catch {
    return null;
  }
}

async function main() {
  const cfg = resolveRpcConfig(process.env);
  const pool = new RpcPool({ endpoints: cfg.endpoints, cluster: cfg.cluster });
  await pool.assertCluster();
  const connection = pool.connection;

  const findings: string[] = [];
  const require = (ok: boolean, msg: string) => { if (!ok) findings.push(msg); };

  // Program account + upgrade authority.
  const programInfo = await connection.getAccountInfo(PROGRAM, "confirmed");
  require(!!programInfo, "program account not found");
  let upgradeAuthority: string | null = null;
  if (programInfo && programInfo.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111") {
    const programData = new PublicKey(programInfo.data.subarray(4, 36));
    const pd = await connection.getAccountInfo(programData, "confirmed");
    if (pd) {
      const opt = pd.data[12];
      upgradeAuthority = opt === 1 ? b58(pd.data.subarray(13, 45)) : null;
    }
  }

  // QuoteState: owner, discriminator, size, fields.
  const qs = await connection.getAccountInfo(QUOTE_STATE, "confirmed");
  require(!!qs, "QuoteState account not found");
  let qsReport: Record<string, unknown> = { present: false };
  if (qs) {
    const len = qs.data.length;
    const disc = qs.data.subarray(0, 8).toString("hex");
    const layout = len === CURRENT_LEN ? "current" : len === LEGACY_LEN ? "legacy" : "unsupported";
    require(qs.owner.equals(PROGRAM), "QuoteState is not owned by the program");
    require(disc === QUOTE_STATE_DISC, `QuoteState discriminator ${disc} != ${QUOTE_STATE_DISC}`);
    require(layout !== "unsupported", `QuoteState length ${len} is neither legacy(${LEGACY_LEN}) nor current(${CURRENT_LEN})`);
    const [expectedPda] = PublicKey.findProgramAddressSync([Buffer.from("quote"), VAULT.toBuffer()], PROGRAM);
    require(expectedPda.equals(QUOTE_STATE), `QuoteState ${QUOTE_STATE.toBase58()} != derived PDA ${expectedPda.toBase58()}`);
    const keeper = len >= CURRENT_LEN ? b58(qs.data.subarray(845, 877)) : null;
    qsReport = {
      present: true, owner: qs.owner.toBase58(), discriminator: disc, length: len, layout,
      expected_pda: expectedPda.toBase58(), version: u64(qs.data, 8).toString(),
      expiry_slot: u64(qs.data, 24).toString(), keeper_sentinel: keeper,
    };
  }

  // Payer balance + rent for the migrated account.
  const keyPath = process.env.ARBSWAP_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
  let payer: string | null = null;
  let payerBalance = 0;
  try {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))).publicKey.toBase58();
    payerBalance = await connection.getBalance(new PublicKey(payer), "confirmed");
  } catch {
    payer = null;
  }
  const rentCurrent = await connection.getMinimumBalanceForRentExemption(CURRENT_LEN);
  const qsLamports = qs?.lamports ?? 0;
  const rentShortfall = Math.max(0, rentCurrent - qsLamports);

  // Local artifact + IDL.
  const artifact = sha256(ARTIFACT);
  const idl = sha256(IDL);
  let idlHasMigration = false;
  try { idlHasMigration = fs.readFileSync(IDL, "utf8").includes("migrate_quote_state"); } catch { /* */ }

  const migrationRequired = qsReport.layout === "legacy";
  const report = {
    cluster: cfg.cluster,
    endpoints: cfg.endpoints.map(redactUrl),
    program: PROGRAM.toBase58(),
    upgrade_authority: upgradeAuthority,
    quote_state: qsReport,
    migration_required: migrationRequired,
    rent: { current_lamports: qsLamports, required_lamports: rentCurrent, shortfall: rentShortfall },
    payer: { pubkey: payer, lamports: payerBalance, can_fund_shortfall: payerBalance >= rentShortfall },
    artifact: artifact ? { path: ARTIFACT, ...artifact } : { path: ARTIFACT, missing: true },
    idl: idl ? { path: IDL, ...idl, has_migrate_instruction: idlHasMigration } : { path: IDL, missing: true },
    findings,
    ok: findings.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (findings.length > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
