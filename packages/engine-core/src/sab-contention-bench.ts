/**
 * SAB Phase 4 contention benchmark (not part of `npm test`).
 *
 * Run: `node dist/src/sab-contention-bench.js`
 *
 * Toward the scale target — 51,200 actors (1,000 users + 50,000 objects)
 * hammering shared pools concurrently — three runs over the same op mix:
 *   1. atomic multi-worker (production Atomics patterns)
 *   2. plain multi-worker (deliberately racy read-modify-write baseline)
 *   3. atomic single-threaded (same op sequences, no parallelism)
 * plus a single-pool hotspot run (all actors on ONE counter: maximum
 * contention, CAS-retry + latency-tail story).
 *
 * Correctness bar: run 1 and 3 must reconcile EXACTLY (drift 0). Run 2
 * is expected to LOSE updates — its drift is the measured cost of
 * skipping Atomics.
 */

import { availableParallelism, cpus } from "node:os";
import {
  runContention,
  runContentionSingleThreaded,
  type ContentionRun,
} from "./sab-contention.js";

const TOTAL_ACTORS = 51_200; // 1,000 users + 50,000 objects/NPCs, one region
const OPS_PER_ACTOR = 20;
const POOLS = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000];
const RESOURCES = 512;

const fmt = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmt2 = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function report(label: string, run: ContentionRun): void {
  const t = run.totals;
  console.log(`\n--- ${label} ---`);
  console.log(`  workers: ${run.config.workers}  actors: ${run.config.workers * run.config.actorsPerWorker}  ops: ${fmt(run.totalOps)}`);
  console.log(`  wall: ${fmt2(run.wallMs)} ms  throughput: ${fmt(run.opsPerSec)} ops/sec`);
  console.log(`  harvest: ${fmt(t.harvestSuccess)} ok / ${fmt(t.harvestFail)} insufficient  (CAS attempts/op: ${fmt2(t.casAttemptsPerHarvest)})`);
  console.log(`  claims: ${fmt(t.claimSuccess)} won / ${fmt(t.claimContended)} contended  release violations: ${t.releaseViolations}`);
  console.log(`  op latency (histogram approx): p50 ${(run.latenciesNs.p50 / 1000).toFixed(2)} µs  p95 ${(run.latenciesNs.p95 / 1000).toFixed(2)} µs  p99 ${(run.latenciesNs.p99 / 1000).toFixed(2)} µs  max-bucket ${(run.latenciesNs.max / 1000).toFixed(2)} µs`);
  console.log(`  claim latency: p50 ${(run.claimLatenciesNs.p50 / 1000).toFixed(2)} µs  p95 ${(run.claimLatenciesNs.p95 / 1000).toFixed(2)} µs  p99 ${(run.claimLatenciesNs.p99 / 1000).toFixed(2)} µs`);
  console.log(`  reconcile: ok=${run.reconcile.ok}  poolDrift=[${run.reconcile.poolDrift.join(", ")}]  ownersHeld=${run.reconcile.ownersHeld}  harvestedMismatch=${run.reconcile.harvestedMismatch}`);
}

async function main(): Promise<void> {
  // Oversubscribe deliberately: with 2 workers on 2 CPUs the race window
  // between load and store is rarely hit, so contention barely shows.
  // 8 workers time-sharing 2 CPUs interleave far more often — closer to
  // what 1,000 users' worth of actors does to one pool on a real server
  // (where workers ≈ cores). Throughput vs single-threaded on this tiny
  // VM is therefore a contention story, not a parallelism story.
  const workers = Math.max(1, Math.min(8, availableParallelism() * 4));
  const actorsPerWorker = Math.ceil(TOTAL_ACTORS / workers);
  console.log(`SAB Phase 4 contention benchmark — ${cpus().length} logical CPUs, ${workers} workers`);
  console.log(`workload: ${fmt(workers * actorsPerWorker)} actors x ${OPS_PER_ACTOR} ops, ${POOLS.length} pools, ${RESOURCES} claimable resources`);

  const atomic = await runContention({
    workers,
    actorsPerWorker,
    opsPerActor: OPS_PER_ACTOR,
    pools: POOLS,
    resources: RESOURCES,
    seed: 0x5ab4,
    mode: "atomic",
  });
  report("1. atomic multi-worker (production)", atomic);

  const plain = await runContention({
    workers,
    actorsPerWorker,
    opsPerActor: OPS_PER_ACTOR,
    pools: POOLS,
    resources: RESOURCES,
    seed: 0x5ab4,
    mode: "plain",
  });
  report("2. plain multi-worker (racy baseline — expected to lose updates)", plain);
  const lost = plain.reconcile.poolDrift.reduce((a, d) => a + Math.abs(d), 0);
  console.log(`  ==> non-atomic baseline LOST ${fmt(lost)} pool updates (drift), owners stuck: ${plain.reconcile.ownersHeld}, release violations: ${plain.totals.releaseViolations}`);

  const single = runContentionSingleThreaded({
    totalActors: workers * actorsPerWorker,
    opsPerActor: OPS_PER_ACTOR,
    pools: POOLS,
    resources: RESOURCES,
    seed: 0x5ab4,
    mode: "atomic",
  });
  console.log(`\n--- 3. atomic single-threaded (same op sequences) ---`);
  console.log(`  wall: ${fmt2(single.wallMs)} ms  throughput: ${fmt(single.opsPerSec)} ops/sec  reconcile ok=${single.reconcile.ok}`);
  console.log(`  ==> multi-worker vs single-threaded: ${fmt2(atomic.opsPerSec / single.opsPerSec)}x throughput (parallelism + worker overhead on ${workers} workers)`);

  const hotspot = await runContention({
    workers,
    actorsPerWorker,
    opsPerActor: OPS_PER_ACTOR,
    pools: [10_000_000],
    resources: 64,
    seed: 0x5ab4,
    mode: "atomic",
  });
  report("4. atomic hotspot (all actors, ONE pool)", hotspot);
  console.log(`  ==> hotspot CAS retries: ${fmt(hotspot.totals.harvestAttempts - hotspot.totals.harvestSuccess)} extra attempts over ${fmt(hotspot.totals.harvestSuccess)} successes; reconciliation still exact: ${hotspot.reconcile.ok}`);

  if (!atomic.reconcile.ok || !single.reconcile.ok || !hotspot.reconcile.ok) {
    console.error("\nBENCHMARK GATE FAILED: an atomic run did not reconcile exactly.");
    process.exitCode = 1;
  } else {
    console.log("\nBENCHMARK GATE PASSED: all atomic runs reconciled exactly.");
  }
}

await main();
