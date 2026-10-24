/**
 * SAB Phase 4: worker sharing + Atomics contention harness.
 *
 * Phase 1 put bitECS component stores in SharedArrayBuffers; Phase 2 gave
 * the C++ physics boundary zero-copy access to them. This module proves the
 * third leg: the SAME shared memory is safely usable from Node
 * `worker_threads`, with Atomics-based access patterns for contested
 * resources — the primitive the scale target needs (1,000 concurrent users
 * + 50,000 actors hammering the SAME resource pools in ONE region, no
 * sharding escape hatch).
 *
 * What lives here:
 * - `SharedPools`: a single SharedArrayBuffer holding per-pool resource
 *   counters (stock), per-pool initial stock, per-pool net-harvested
 *   totals, and per-resource exclusive-owner slots. Created on the main
 *   thread, passed to workers via `workerData` — structured clone shares
 *   a SharedArrayBuffer by reference, so workers touch the same memory,
 *   no copy, no serialization.
 * - Atomic access patterns (the production patterns for contested state):
 *   `tryHarvest` — CAS loop: load, check sufficiency, compareExchange;
 *   the winner's deduction is atomic, losers retry against fresh state.
 *   `deposit` — `Atomics.add` (and a matching `Atomics.sub` on the
 *   net-harvested total, so the reconciliation invariant holds).
 *   `tryClaim` / `release` — `Atomics.compareExchange` on an owner slot
 *   (0 = free, else actorId + 1); release only succeeds for the owner,
 *   so a failed release is a counted exclusivity violation (must be 0).
 * - `runContention`: spawns N workers, each simulating a slice of actors
 *   hammering the same pools, and reconciles exactly:
 *   `remaining + netHarvested == initial` per pool, all owner slots free,
 *   shared harvested totals == sum of per-worker local totals.
 * - Deliberately racy `plain*` variants (read-modify-write without
 *   Atomics) exist ONLY as the non-atomic baseline for the benchmark.
 *   They lose updates under contention by construction — never use them
 *   for real state.
 *
 * Determinism: this harness is concurrency test tooling, NOT sim logic.
 * It never runs on the deterministic tick path, and no algorithm or flag
 * the sim depends on is changed here. Interleavings vary run to run;
 * the reconciliation invariants must hold on every run.
 */

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

/** Op mix for the contention workload (fractions of each actor's ops). */
export const CONTENTION_OP_MIX = {
  /** CAS-loop harvest of 1 unit from a random pool. */
  harvest: 0.6,
  /** Atomic deposit of 1 unit back into a random pool. */
  deposit: 0.2,
  /** CAS claim of a random resource, brief hold, owner-checked release. */
  claim: 0.2,
} as const;

/** Histogram buckets: bucket i covers [2^i, 2^(i+1)) nanoseconds. */
export const LATENCY_BUCKETS = 17;

/** Per-worker workload + result types (shared with sab-contention-worker). */
export interface ContentionWorkerData {
  sab: SharedArrayBuffer;
  workerIndex: number;
  actorStart: number;
  actorCount: number;
  opsPerActor: number;
  seed: number;
  /** "atomic" = production patterns; "plain" = deliberately racy baseline. */
  mode: "atomic" | "plain";
}

export interface ContentionWorkerResult {
  workerIndex: number;
  ops: number;
  harvestAttempts: number;
  harvestSuccess: number;
  harvestFail: number;
  deposits: number;
  claimAttempts: number;
  claimSuccess: number;
  claimContended: number;
  releaseViolations: number;
  /** Locally tracked net harvested (harvests minus deposits). */
  harvestedNet: number;
  /** Per-op latency histogram (harvest CAS loops + deposits), nanoseconds. */
  opHistogram: number[];
  /** Claim-attempt latency histogram (single CAS), nanoseconds. */
  claimHistogram: number[];
  wallMs: number;
}

export interface ContentionConfig {
  workers: number;
  actorsPerWorker: number;
  opsPerActor: number;
  /** Initial stock per pool. */
  pools: number[];
  /** Number of exclusively claimable resources. */
  resources: number;
  seed?: number;
  mode?: "atomic" | "plain";
  /** Reject if workers do not report within this long (default 120 s). */
  timeoutMs?: number;
}

export interface ContentionRun {
  config: Required<Omit<ContentionConfig, "pools">> & { pools: number[] };
  wallMs: number;
  opsPerSec: number;
  totalOps: number;
  perWorker: ContentionWorkerResult[];
  totals: {
    harvestAttempts: number;
    harvestSuccess: number;
    harvestFail: number;
    deposits: number;
    claimAttempts: number;
    claimSuccess: number;
    claimContended: number;
    releaseViolations: number;
    harvestedNetLocal: number;
    harvestedNetShared: number;
    /** CAS attempts per successful harvest — >1 means retries under contention. */
    casAttemptsPerHarvest: number;
  };
  /** Merged per-op latency histogram (nanoseconds, bucketed). */
  opHistogram: number[];
  /** Merged claim latency histogram (nanoseconds, bucketed). */
  claimHistogram: number[];
  latenciesNs: { p50: number; p95: number; p99: number; max: number };
  claimLatenciesNs: { p50: number; p95: number; p99: number; max: number };
  reconcile: {
    ok: boolean;
    /** Per-pool `remaining + netHarvested - initial` (must all be 0). */
    poolDrift: number[];
    /** Owner slots still held at the end (must be 0). */
    ownersHeld: number;
    /** Shared harvested total minus sum of local totals (must be 0). */
    harvestedMismatch: number;
    /** Remaining stock per pool at the end of the run. */
    remaining: number[];
  };
}

// ---------------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------------

/**
 * One SharedArrayBuffer, all Int32 words:
 *   [0] poolCount, [1] resourceCount,
 *   pools[poolCount]      — current stock per pool
 *   initial[poolCount]    — initial stock per pool (reconciliation anchor)
 *   harvested[poolCount]  — NET harvested per pool (harvests minus deposits)
 *   owners[resourceCount]  — exclusive owner slot per resource (0 = free)
 */
const HEADER_WORDS = 2;

function layout(poolCount: number, resourceCount: number) {
  const pools = HEADER_WORDS;
  const initial = pools + poolCount;
  const harvested = initial + poolCount;
  const owners = harvested + poolCount;
  const totalWords = owners + resourceCount;
  return { pools, initial, harvested, owners, totalWords };
}

export interface SharedPools {
  sab: SharedArrayBuffer;
  poolCount: number;
  resourceCount: number;
  /** Whole-buffer Int32 view (header + all sections). */
  words: Int32Array;
  /** Offsets (in Int32 words) of each section. */
  offsets: { pools: number; initial: number; harvested: number; owners: number };
}

/** Allocate a new shared pool buffer with the given initial stocks. */
export function createSharedPools(
  initialStocks: number[],
  resourceCount: number,
): SharedPools {
  if (initialStocks.length === 0) {
    throw new Error("sab-contention: need at least one pool");
  }
  if (resourceCount < 0 || !Number.isInteger(resourceCount)) {
    throw new Error("sab-contention: resourceCount must be a non-negative integer");
  }
  const { totalWords } = layout(initialStocks.length, resourceCount);
  const sab = new SharedArrayBuffer(totalWords * Int32Array.BYTES_PER_ELEMENT);
  // Header must be written before attach: attach validates it.
  new Int32Array(sab)[0] = initialStocks.length;
  new Int32Array(sab)[1] = resourceCount;
  const pools = attachSharedPools(sab);
  for (let i = 0; i < initialStocks.length; i++) {
    pools.words[pools.offsets.pools + i] = initialStocks[i];
    pools.words[pools.offsets.initial + i] = initialStocks[i];
  }
  return pools;
}

/** Attach to an existing shared pool buffer (main thread or worker). */
export function attachSharedPools(sab: SharedArrayBuffer): SharedPools {
  const words = new Int32Array(sab);
  const poolCount = words[0];
  const resourceCount = words[1];
  if (
    !Number.isInteger(poolCount) ||
    poolCount <= 0 ||
    !Number.isInteger(resourceCount) ||
    resourceCount < 0
  ) {
    throw new Error(
      `sab-contention: bad header (poolCount=${poolCount}, resourceCount=${resourceCount})`,
    );
  }
  const { totalWords, ...offsets } = layout(poolCount, resourceCount);
  if (words.length < totalWords) {
    throw new Error(
      `sab-contention: buffer too small (${words.length} words, need ${totalWords})`,
    );
  }
  return { sab, poolCount, resourceCount, words, offsets };
}

// ---------------------------------------------------------------------------
// Atomic access patterns (production)
// ---------------------------------------------------------------------------

export function readPool(pools: SharedPools, pool: number): number {
  return Atomics.load(pools.words, pools.offsets.pools + pool);
}

export function readHarvested(pools: SharedPools, pool: number): number {
  return Atomics.load(pools.words, pools.offsets.harvested + pool);
}

/**
 * Harvest `amount` from a pool via a CAS loop. Returns true on success.
 * On success the net-harvested total is updated atomically too, so
 * `remaining + netHarvested == initial` holds under any interleaving.
 * `attempts` counts CAS tries (1 = uncontended, more = retries).
 */
export function tryHarvest(
  pools: SharedPools,
  pool: number,
  amount: number,
  attempts?: { count: number },
): boolean {
  const idx = pools.offsets.pools + pool;
  for (;;) {
    if (attempts) attempts.count++;
    const seen = Atomics.load(pools.words, idx);
    if (seen < amount) return false;
    if (
      Atomics.compareExchange(pools.words, idx, seen, seen - amount) === seen
    ) {
      Atomics.add(pools.words, pools.offsets.harvested + pool, amount);
      return true;
    }
    // Lost the race: another actor changed the stock — retry on fresh state.
  }
}

/** Deposit `amount` back into a pool (atomic add; net-harvested adjusted). */
export function deposit(pools: SharedPools, pool: number, amount: number): void {
  Atomics.add(pools.words, pools.offsets.pools + pool, amount);
  Atomics.sub(pools.words, pools.offsets.harvested + pool, amount);
}

/**
 * Exclusively claim a resource via CAS on its owner slot. The stored
 * owner is actorId + 1 so actor 0 is distinguishable from "free" (0).
 */
export function tryClaim(
  pools: SharedPools,
  resource: number,
  actorId: number,
): boolean {
  return (
    Atomics.compareExchange(
      pools.words,
      pools.offsets.owners + resource,
      0,
      actorId + 1,
    ) === 0
  );
}

/**
 * Release a resource. Succeeds only if this actor is the recorded owner —
 * a false return is an exclusivity violation (double-claim / stolen
 * release), never a silent success.
 */
export function release(
  pools: SharedPools,
  resource: number,
  actorId: number,
): boolean {
  return (
    Atomics.compareExchange(
      pools.words,
      pools.offsets.owners + resource,
      actorId + 1,
      0,
    ) ===
    actorId + 1
  );
}

// ---------------------------------------------------------------------------
// Deliberately racy baseline (benchmark only — never production state)
// ---------------------------------------------------------------------------

/** Non-atomic harvest: racy read-modify-write, loses updates by design. */
export function plainHarvest(
  pools: SharedPools,
  pool: number,
  amount: number,
): boolean {
  const idx = pools.offsets.pools + pool;
  const seen = pools.words[idx];
  if (seen < amount) return false;
  pools.words[idx] = seen - amount;
  pools.words[pools.offsets.harvested + pool] += amount;
  return true;
}

/** Non-atomic deposit. */
export function plainDeposit(
  pools: SharedPools,
  pool: number,
  amount: number,
): void {
  pools.words[pools.offsets.pools + pool] += amount;
  pools.words[pools.offsets.harvested + pool] -= amount;
}

/** Non-atomic claim: two actors can both observe "free" and both claim. */
export function plainClaim(
  pools: SharedPools,
  resource: number,
  actorId: number,
): boolean {
  const idx = pools.offsets.owners + resource;
  if (pools.words[idx] !== 0) return false;
  pools.words[idx] = actorId + 1;
  return true;
}

/** Non-atomic release. */
export function plainRelease(
  pools: SharedPools,
  resource: number,
  actorId: number,
): boolean {
  const idx = pools.offsets.owners + resource;
  if (pools.words[idx] !== actorId + 1) return false;
  pools.words[idx] = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic per-actor workload (shared by worker + single-threaded runs)
// ---------------------------------------------------------------------------

/** mulberry32: small deterministic PRNG, one stream per actor. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bucket index for a latency in nanoseconds (power-of-2 buckets). */
export function latencyBucket(ns: number): number {
  if (!(ns > 0)) return 0;
  const b = Math.floor(Math.log2(ns));
  return Math.min(Math.max(b, 0), LATENCY_BUCKETS - 1);
}

/** Approximate percentile from a power-of-2 bucket histogram (geometric bucket mid). */
export function percentileFromHistogram(hist: number[], p: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const target = (p / 100) * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) {
      if (i === hist.length - 1) return 65536;
      const lo = 2 ** i;
      const hi = 2 ** (i + 1);
      return Math.sqrt(lo * hi);
    }
  }
  return 65536;
}

export function mergeHistograms(hists: number[][]): number[] {
  const out = new Array<number>(LATENCY_BUCKETS).fill(0);
  for (const h of hists) for (let i = 0; i < LATENCY_BUCKETS; i++) out[i] += h[i] ?? 0;
  return out;
}

/**
 * Run one actor slice's workload against shared pools. Used verbatim by
 * the worker entry point and by the single-threaded baseline, so the
 * two runs differ only in parallelism, not in op sequences.
 */
export function runActorWorkload(
  pools: SharedPools,
  actorStart: number,
  actorCount: number,
  opsPerActor: number,
  seed: number,
  mode: "atomic" | "plain",
): Omit<ContentionWorkerResult, "workerIndex" | "wallMs"> {
  const stats = {
    ops: 0,
    harvestAttempts: 0,
    harvestSuccess: 0,
    harvestFail: 0,
    deposits: 0,
    claimAttempts: 0,
    claimSuccess: 0,
    claimContended: 0,
    releaseViolations: 0,
    harvestedNet: 0,
    opHistogram: new Array<number>(LATENCY_BUCKETS).fill(0),
    claimHistogram: new Array<number>(LATENCY_BUCKETS).fill(0),
  };
  const doDeposit = mode === "atomic" ? deposit : plainDeposit;
  const claim = mode === "atomic" ? tryClaim : plainClaim;
  const doRelease = mode === "atomic" ? release : plainRelease;

  for (let a = 0; a < actorCount; a++) {
    const actorId = actorStart + a;
    // Per-actor stream: the same actor performs the same op sequence in
    // worker runs and in single-threaded runs; only interleaving differs.
    const rng = mulberry32((seed ^ Math.imul(actorId + 1, 2654435761)) >>> 0);
    for (let op = 0; op < opsPerActor; op++) {
      const r = rng();
      stats.ops++;
      if (r < CONTENTION_OP_MIX.harvest) {
        const pool = Math.floor(rng() * pools.poolCount);
        // hrtime.bigint: nanosecond resolution. performance.now() (~µs
        // granularity) collapsed every op into one bucket — useless for
        // percentiles on sub-µs Atomics ops. Two hrtime calls cost
        // ~50-100 ns/op of measured overhead; reported latencies include it.
        const t0 = process.hrtime.bigint();
        const attempts = { count: 0 };
        const ok =
          mode === "atomic"
            ? tryHarvest(pools, pool, 1, attempts)
            : plainHarvest(pools, pool, 1);
        stats.harvestAttempts += mode === "atomic" ? attempts.count : 1;
        const ns = Number(process.hrtime.bigint() - t0);
        stats.opHistogram[latencyBucket(ns)]++;
        if (ok) {
          stats.harvestSuccess++;
          stats.harvestedNet += 1;
        } else {
          stats.harvestFail++;
        }
      } else if (r < CONTENTION_OP_MIX.harvest + CONTENTION_OP_MIX.deposit) {
        const pool = Math.floor(rng() * pools.poolCount);
        const t0 = process.hrtime.bigint();
        doDeposit(pools, pool, 1);
        const ns = Number(process.hrtime.bigint() - t0);
        stats.opHistogram[latencyBucket(ns)]++;
        stats.deposits++;
        stats.harvestedNet -= 1;
      } else {
        const resource =
          pools.resourceCount === 0
            ? -1
            : Math.floor(rng() * pools.resourceCount);
        if (resource < 0) continue;
        const t0 = process.hrtime.bigint();
        const won = claim(pools, resource, actorId);
        const ns = Number(process.hrtime.bigint() - t0);
        stats.claimHistogram[latencyBucket(ns)]++;
        stats.claimAttempts++;
        if (won) {
          stats.claimSuccess++;
          // Brief deterministic hold: simulate critical-section work
          // without touching shared memory (no shared access while held).
          let checksum = 0;
          for (let i = 0; i < 50; i++) checksum = (checksum + i * 31) | 0;
          if (checksum === -1) stats.releaseViolations++; // never; keeps the loop live
          if (!doRelease(pools, resource, actorId)) {
            stats.releaseViolations++;
          }
        } else {
          stats.claimContended++;
        }
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Verify the exact invariants that must hold after any run. */
export function reconcile(
  pools: SharedPools,
  localHarvestedNet: number,
): ContentionRun["reconcile"] {
  const poolDrift: number[] = [];
  const remaining: number[] = [];
  for (let i = 0; i < pools.poolCount; i++) {
    const rem = readPool(pools, i);
    const net = readHarvested(pools, i);
    const initial = pools.words[pools.offsets.initial + i];
    remaining.push(rem);
    poolDrift.push(rem + net - initial);
  }
  let ownersHeld = 0;
  for (let i = 0; i < pools.resourceCount; i++) {
    if (Atomics.load(pools.words, pools.offsets.owners + i) !== 0) ownersHeld++;
  }
  const sharedNet = pools.words
    .slice(
      pools.offsets.harvested,
      pools.offsets.harvested + pools.poolCount,
    )
    .reduce((a, b) => a + b, 0);
  return {
    ok:
      poolDrift.every((d) => d === 0) &&
      ownersHeld === 0 &&
      sharedNet === localHarvestedNet,
    poolDrift,
    ownersHeld,
    harvestedMismatch: sharedNet - localHarvestedNet,
    remaining,
  };
}

// ---------------------------------------------------------------------------
// Multi-worker harness
// ---------------------------------------------------------------------------

/**
 * Run the contention workload across worker_threads sharing one SAB.
 * Main thread creates the pools; workers attach to the same memory.
 */
export async function runContention(cfg: ContentionConfig): Promise<ContentionRun> {
  const config = {
    workers: cfg.workers,
    actorsPerWorker: cfg.actorsPerWorker,
    opsPerActor: cfg.opsPerActor,
    pools: [...cfg.pools],
    resources: cfg.resources,
    seed: cfg.seed ?? 0x5ab4,
    mode: cfg.mode ?? "atomic",
    timeoutMs: cfg.timeoutMs ?? 120_000,
  };
  if (config.workers < 1) throw new Error("sab-contention: workers >= 1");
  if (config.actorsPerWorker < 1) throw new Error("sab-contention: actorsPerWorker >= 1");
  if (config.opsPerActor < 1) throw new Error("sab-contention: opsPerActor >= 1");

  const pools = createSharedPools(config.pools, config.resources);
  const t0 = performance.now();

  const perWorker = await Promise.all(
    Array.from({ length: config.workers }, (_, workerIndex) => {
      return new Promise<ContentionWorkerResult>((resolvePromise, rejectPromise) => {
        let settled = false;
        const worker = new Worker(
          new URL("./sab-contention-worker.js", import.meta.url),
          {
            workerData: {
              sab: pools.sab,
              workerIndex,
              actorStart: workerIndex * config.actorsPerWorker,
              actorCount: config.actorsPerWorker,
              opsPerActor: config.opsPerActor,
              seed: config.seed,
              mode: config.mode,
            } satisfies ContentionWorkerData,
          },
        );
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          void worker.terminate();
          rejectPromise(
            new Error(`sab-contention: worker ${workerIndex} timed out after ${config.timeoutMs} ms`),
          );
        }, config.timeoutMs);
        timer.unref?.();
        worker.on("message", (msg: ContentionWorkerResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          resolvePromise(msg);
        });
        worker.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          rejectPromise(err);
        });
        worker.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(
            new Error(`sab-contention: worker ${workerIndex} exited (code ${code}) before reporting`),
          );
        });
      });
    }),
  );

  const wallMs = performance.now() - t0;
  const totalOps = perWorker.reduce((a, w) => a + w.ops, 0);
  const totals = {
    harvestAttempts: perWorker.reduce((a, w) => a + w.harvestAttempts, 0),
    harvestSuccess: perWorker.reduce((a, w) => a + w.harvestSuccess, 0),
    harvestFail: perWorker.reduce((a, w) => a + w.harvestFail, 0),
    deposits: perWorker.reduce((a, w) => a + w.deposits, 0),
    claimAttempts: perWorker.reduce((a, w) => a + w.claimAttempts, 0),
    claimSuccess: perWorker.reduce((a, w) => a + w.claimSuccess, 0),
    claimContended: perWorker.reduce((a, w) => a + w.claimContended, 0),
    releaseViolations: perWorker.reduce((a, w) => a + w.releaseViolations, 0),
    harvestedNetLocal: perWorker.reduce((a, w) => a + w.harvestedNet, 0),
    harvestedNetShared: 0,
    casAttemptsPerHarvest: 0,
  };
  totals.harvestedNetShared = Array.from(
    pools.words.slice(
      pools.offsets.harvested,
      pools.offsets.harvested + pools.poolCount,
    ),
  ).reduce((a, b) => a + b, 0);
  totals.casAttemptsPerHarvest =
    totals.harvestSuccess > 0
      ? totals.harvestAttempts / totals.harvestSuccess
      : 0;

  const opHistogram = mergeHistograms(perWorker.map((w) => w.opHistogram));
  const claimHistogram = mergeHistograms(perWorker.map((w) => w.claimHistogram));
  const histMax = (hist: number[]): number => {
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i] > 0) return i === hist.length - 1 ? 65536 : 2 ** (i + 1);
    }
    return 0;
  };

  return {
    config,
    wallMs,
    opsPerSec: totalOps / (wallMs / 1000),
    totalOps,
    perWorker,
    totals,
    opHistogram,
    claimHistogram,
    latenciesNs: {
      p50: percentileFromHistogram(opHistogram, 50),
      p95: percentileFromHistogram(opHistogram, 95),
      p99: percentileFromHistogram(opHistogram, 99),
      max: histMax(opHistogram),
    },
    claimLatenciesNs: {
      p50: percentileFromHistogram(claimHistogram, 50),
      p95: percentileFromHistogram(claimHistogram, 95),
      p99: percentileFromHistogram(claimHistogram, 99),
      max: histMax(claimHistogram),
    },
    reconcile: reconcile(pools, totals.harvestedNetLocal),
  };
}

/**
 * Single-threaded baseline: the same per-actor op sequences, run
 * sequentially in-process. Reconciliation must hold here too; the
 * comparison that matters is correctness parity + throughput delta.
 */
export function runContentionSingleThreaded(
  cfg: Omit<ContentionConfig, "workers" | "timeoutMs" | "actorsPerWorker"> & { totalActors: number },
): {
  wallMs: number;
  opsPerSec: number;
  totalOps: number;
  reconcile: ContentionRun["reconcile"];
  releaseViolations: number;
} {
  const pools = createSharedPools(cfg.pools, cfg.resources);
  const t0 = performance.now();
  const stats = runActorWorkload(
    pools,
    0,
    cfg.totalActors,
    cfg.opsPerActor,
    cfg.seed ?? 0x5ab4,
    cfg.mode ?? "atomic",
  );
  const wallMs = performance.now() - t0;
  return {
    wallMs,
    opsPerSec: stats.ops / (wallMs / 1000),
    totalOps: stats.ops,
    reconcile: reconcile(pools, stats.harvestedNet),
    releaseViolations: stats.releaseViolations,
  };
}
