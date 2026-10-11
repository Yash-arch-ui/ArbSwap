// CI gate: fail on any high/critical production npm-audit finding that is not
// covered by a dated waiver in frontend/audit-allowlist.json, or whose review
// date has passed. See docs/WEB_ASSUMPTIONS.md.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../app', import.meta.url));
const allowPath = fileURLToPath(new URL('../frontend/audit-allowlist.json', import.meta.url));
const allow = JSON.parse(readFileSync(allowPath, 'utf8'));
const allowed = new Map(allow.waivers.map((w) => [w.package, w]));
const today = new Date().toISOString().slice(0, 10);

let raw = '{}';
try {
  raw = execSync('npm audit --omit=dev --json', { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  raw = error.stdout || '{}'; // npm audit exits non-zero when findings exist
}
const vulns = (JSON.parse(raw).vulnerabilities) || {};
const findings = Object.entries(vulns).filter(([, i]) => i.severity === 'high' || i.severity === 'critical');

let failed = false;
for (const [name, info] of findings) {
  const waiver = allowed.get(name);
  if (!waiver) {
    console.error(`FAIL: ${name} [${info.severity}] is not in frontend/audit-allowlist.json`);
    failed = true;
  } else if (waiver.review_by < today) {
    console.error(`FAIL: ${name} waiver expired (review_by ${waiver.review_by})`);
    failed = true;
  } else {
    console.log(`waived: ${name} [${info.severity}] review_by ${waiver.review_by}`);
  }
}
for (const name of allowed.keys()) {
  if (!vulns[name]) console.log(`note: waiver for ${name} is stale (no current finding)`);
}
if (failed) process.exit(1);
console.log(`audit gate: ${findings.length} high/critical production finding(s), all waived`);
