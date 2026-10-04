/**
 * E5 bench results: print a JSON summary to stdout and append a dated
 * markdown section to docs/EDGE-SPLIT-RESULTS.md (created if missing).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FILE = path.join(ROOT, "docs/EDGE-SPLIT-RESULTS.md");

const HEADER = `# Edge / core split: measured results (E5)

Numbers for [\`EDGE-CORE-SPLIT.md\`](EDGE-CORE-SPLIT.md) slice E5. Each
benchmark appends a dated section; run them all with \`npm run bench:e5\`.
Budgets: B1 p99 < 1 ms added by the hop; B3 pushes add < 0.5 ms mean per
tick; B4 encode p99 < 5 ms. B2 is flagged if p99 > 10 ms at 100 clients.
B5 records timings without pass/fail; B6 asserts stability.
`;

export function machine() {
  const cpus = os.cpus();
  let commit = "unknown";
  try { commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { /* not a checkout */ }
  return {
    cpu: `${cpus[0]?.model ?? "unknown"} x${cpus.length}`,
    memGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    commit,
  };
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean: round(mean), p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), p99: round(percentile(s, 99)), max: round(s[s.length - 1]) };
}

export const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : x);

/** Record one bench: `body` is markdown (tables, verdicts). */
export function record(id, title, summary, body) {
  const m = machine();
  const out = { bench: id, date: new Date().toISOString(), machine: m, ...summary };
  console.log(JSON.stringify(out, null, 2));
  if (process.env.E5_NO_RECORD === "1") return out;
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, HEADER);
  const section = `\n## ${id}: ${title} (${out.date.slice(0, 10)})\n\n` +
    `Machine: ${m.cpu}, ${m.memGiB} GiB, ${m.os}, Node ${m.node}. Commit \`${m.commit}\`.\n\n${body.trim()}\n`;
  fs.appendFileSync(FILE, section);
  return out;
}
