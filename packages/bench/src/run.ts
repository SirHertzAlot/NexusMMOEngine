/**
 * Slice-1.5 validation benchmark driver (Phase 1 plan §6).
 *
 * For each N in {1k, 10k, 100k}: correctness-check harness A vs B (exact
 * f32 equality after 60 ticks), then 200 warmup + 1000 measured ticks per
 * harness. Also micro-measures empty N-API call overhead. Prints a table
 * and writes RESULTS.md with the verdict on the reopen rule.
 *
 * Usage: npm run bench   (from the repo root: npm run bench)
 */

import { execSync } from "node:child_process";
import { cpus, platform, arch, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addon,
  DT,
  maxPositionDiff,
  setupHarnessA,
  setupHarnessB,
} from "./harness.js";

const SIZES = [1_000, 10_000, 100_000];
const WARMUP_TICKS = 200;
const MEASURED_TICKS = 1_000;
const CORRECTNESS_TICKS = 60;
const TICK_BUDGET_MS = 1000 / 30; // 33.333 ms
const REOPEN_FRACTION = 0.5; // reopen rule: A > 50% of budget at 10k

interface CaseResult {
  n: number;
  harness: "A" | "B";
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  nsPerEntity: number;
  headroomPct: number;
}

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function measure(tick: () => void): { meanMs: number; p95Ms: number; maxMs: number } {
  for (let i = 0; i < WARMUP_TICKS; i++) tick();
  const samples = new Float64Array(MEASURED_TICKS);
  for (let i = 0; i < MEASURED_TICKS; i++) {
    const t0 = process.hrtime.bigint();
    tick();
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const sorted = Float64Array.from(samples).sort();
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return { meanMs: mean, p95Ms: percentile(sorted, 0.95), maxMs: sorted[sorted.length - 1] };
}

function maybeGc(): void {
  if (typeof global.gc === "function") global.gc();
}

function measureNoopOverhead(): number {
  const CALLS = 100_000;
  for (let i = 0; i < 1000; i++) addon.noop(); // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < CALLS; i++) addon.noop();
  return Number(process.hrtime.bigint() - t0) / CALLS; // ns per call
}

function gxxVersion(): string {
  try {
    return execSync("g++ --version").toString().split("\n")[0].trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  console.log("slice-1.5 validation benchmark");
  console.log(`dt=${DT}s, warmup=${WARMUP_TICKS}, measured=${MEASURED_TICKS} ticks`);

  for (const n of SIZES) {
    // --- correctness: fresh worlds, identical data, 60 ticks, exact match
    const a = setupHarnessA(n, 1337);
    const b = setupHarnessB(a.arrays);
    for (let t = 0; t < CORRECTNESS_TICKS; t++) {
      a.tick();
      b.tick();
    }
    const diff = maxPositionDiff(a.arrays, b.readPositions());
    const ok = diff === 0;
    console.log(
      `n=${n.toLocaleString()}: A/B max position diff after ${CORRECTNESS_TICKS} ticks = ${diff} ${ok ? "EXACT ✓" : "MISMATCH ✗"}`,
    );
    if (!ok) throw new Error(`harness A/B diverged at n=${n} (diff=${diff})`);

    // --- measured runs (order: B then A; fresh state each)
    const bStats = measure(b.tick);
    maybeGc();
    const a2 = setupHarnessA(n, 1337);
    const aStats = measure(a2.tick);
    maybeGc();

    for (const [harness, s] of [
      ["B", bStats],
      ["A", aStats],
    ] as const) {
      results.push({
        n,
        harness,
        meanMs: s.meanMs,
        p95Ms: s.p95Ms,
        maxMs: s.maxMs,
        nsPerEntity: (s.meanMs * 1e6) / n,
        headroomPct: ((TICK_BUDGET_MS - s.p95Ms) / TICK_BUDGET_MS) * 100,
      });
    }
    const ra = results[results.length - 1];
    console.log(
      `  B: mean=${bStats.meanMs.toFixed(3)}ms p95=${bStats.p95Ms.toFixed(3)}ms | ` +
        `A: mean=${ra.meanMs.toFixed(3)}ms p95=${ra.p95Ms.toFixed(3)}ms`,
    );
  }

  const noopNs = measureNoopOverhead();
  console.log(`empty N-API call overhead: ${noopNs.toFixed(1)} ns/call`);

  // --- verdict on the reopen rule
  const a10k = results.find((r) => r.n === 10_000 && r.harness === "A")!;
  const threshold = TICK_BUDGET_MS * REOPEN_FRACTION;
  const reopen = a10k.p95Ms > threshold;
  const verdict = reopen
    ? `REOPEN — harness A p95 (${a10k.p95Ms.toFixed(3)} ms) exceeds 50% of the ` +
      `${TICK_BUDGET_MS.toFixed(2)} ms budget (${threshold.toFixed(2)} ms) at 10k entities.`
    : `HOLD — harness A p95 (${a10k.p95Ms.toFixed(3)} ms) is ${((a10k.p95Ms / TICK_BUDGET_MS) * 100).toFixed(1)}% ` +
      `of the ${TICK_BUDGET_MS.toFixed(2)} ms budget at 10k entities, under the 50% reopen line. ` +
      `JS-world decision stands.`;

  // --- console table
  console.log("\n| entities | harness | mean ms | p95 ms | max ms | ns/entity | p95 headroom |");
  console.log("|----------|---------|---------|--------|--------|-----------|--------------|");
  for (const r of results) {
    console.log(
      `| ${r.n.toLocaleString().padStart(8)} | ${r.harness}       | ` +
        `${r.meanMs.toFixed(3).padStart(7)} | ${r.p95Ms.toFixed(3).padStart(6)} | ` +
        `${r.maxMs.toFixed(3).padStart(6)} | ${r.nsPerEntity.toFixed(1).padStart(9)} | ` +
        `${r.headroomPct.toFixed(1).padStart(6)}%      |`,
    );
  }
  console.log(`\nVerdict: ${verdict}`);

  // --- RESULTS.md
  const cpu = cpus()[0]?.model ?? "unknown";
  const md = `# Slice 1.5 — Validation Benchmark Results

World-location decision under test: **JS world (bitECS) with C++ addons**
vs a pure C++ world, measured on the integration workload
(\`position += velocity * dt\`, f32 SoA).

- Date: ${new Date().toISOString()}
- Machine: ${platform()}/${arch}, ${cpu}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM
- Node: ${process.version}, compiler: ${gxxVersion()} (-O3), N-API (node-addon-api 8.x)
- bitECS 0.3.40, dt=1/30 s, ${WARMUP_TICKS} warmup + ${MEASURED_TICKS} measured ticks per case
- Initial data: deterministic (mulberry32 seed 1337), positions in [-500, 500], velocities in [-20, 20]

## Method

- **Harness A** (the chosen shape): bitECS world sized N; per tick ONE N-API
  call \`integrate(px,py,pz,vx,vy,vz,count,dt)\` operating directly on the
  JS-owned Float32Array component stores. N-API TypedArray access is
  zero-copy (raw pointer into the JS heap); the only marshalling cost is
  argument validation + the call itself.
- **Harness B** (the alternative): pure C++ world (\`World{n, 6x vector<float>}\`);
  per tick ONE N-API call \`stepWorld(handle, dt)\` with no data movement.
- Both harnesses execute the **same** \`integrate_kernel\`; a 60-tick
  correctness check per size asserts **bit-exact** A/B position equality.
- Empty N-API call overhead measured separately (100k \`noop()\` calls).

## Results

| entities | harness | mean (ms) | p95 (ms) | max (ms) | ns/entity | p95 headroom vs 33.33 ms |
|----------|---------|-----------|----------|----------|-----------|--------------------------|
${results
  .map(
    (r) =>
      `| ${r.n.toLocaleString()} | ${r.harness} | ${r.meanMs.toFixed(4)} | ${r.p95Ms.toFixed(4)} | ` +
      `${r.maxMs.toFixed(4)} | ${r.nsPerEntity.toFixed(2)} | ${r.headroomPct.toFixed(1)}% |`,
  )
  .join("\n")}

Empty N-API call overhead: **${noopNs.toFixed(1)} ns/call**.

## Verdict

**${verdict}**

## Caveats

- Harness A measures the steady-state bulk-call shape from the plan: one
  N-API call per tick over shared buffers. JS-side per-entity iteration
  (queries, archetype walks) is not part of this workload; the slice-1.2
  sim (1k entities, full tick incl. FlatBuffers encode) measured p95
  ~11–17 ms, which bounds the real-world orchestration cost.
- Single-threaded; one run per config (run-to-run variance is GC noise —
  max column shows the spike tail).
- Benchmark order per size was B then A with fresh state each; a GC was
  requested between phases when --expose-gc is present.
`;
  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "RESULTS.md",
  ); // dist/src/run.js -> packages/bench/RESULTS.md
  writeFileSync(outPath, md);
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
