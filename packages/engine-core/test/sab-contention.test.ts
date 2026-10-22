/**
 * SAB Phase 4: worker sharing + Atomics contention.
 *
 * Workers attach to the main thread's SharedArrayBuffer (same memory, no
 * copy) and hammer the same pools with Atomics patterns. Every run must
 * reconcile EXACTLY: remaining + netHarvested == initial per pool, all
 * owner slots free, shared totals == sum of local totals, zero release
 * violations. Interleavings vary run to run; the invariants do not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { addEntity, addComponent, createWorld } from "bitecs";
import {
  attachSharedPools,
  createSharedPools,
  deposit,
  release,
  runContention,
  runContentionSingleThreaded,
  tryClaim,
  tryHarvest,
} from "../src/sab-contention.js";
import { Transform } from "../src/components.js";

describe("sab-contention (Phase 4)", () => {
  it("atomic harvest reconciles exactly under multi-worker contention", async () => {
    const run = await runContention({
      workers: 4,
      actorsPerWorker: 64,
      opsPerActor: 500,
      pools: [10_000, 10_000, 10_000, 10_000],
      resources: 32,
      seed: 0x5ab4,
      mode: "atomic",
    });
    assert.equal(run.totalOps, 4 * 64 * 500);
    assert.ok(run.totals.harvestSuccess > 0, "some harvests must succeed");
    assert.ok(run.totals.claimSuccess > 0, "some claims must succeed");
    assert.equal(run.totals.releaseViolations, 0, "no exclusivity violations");
    assert.deepEqual(run.reconcile.poolDrift, [0, 0, 0, 0]);
    assert.equal(run.reconcile.ownersHeld, 0, "all resources released");
    assert.equal(run.reconcile.harvestedMismatch, 0);
    assert.ok(run.reconcile.ok);
    assert.ok(run.opsPerSec > 0);
    assert.ok(run.wallMs > 0);
  });

  it("single-pool hotspot: CAS retries happen, reconciliation still exact", async () => {
    // All actors on ONE pool: maximum contention on one counter.
    const run = await runContention({
      workers: 4,
      actorsPerWorker: 128,
      opsPerActor: 1000,
      pools: [1_000_000],
      resources: 16,
      seed: 0x5ab4,
      mode: "atomic",
    });
    assert.ok(
      run.totals.harvestAttempts > run.totals.harvestSuccess,
      `expected CAS retries under hotspot contention (attempts=${run.totals.harvestAttempts}, successes=${run.totals.harvestSuccess})`,
    );
    assert.ok(run.totals.casAttemptsPerHarvest > 1);
    assert.equal(run.totals.releaseViolations, 0);
    assert.ok(run.reconcile.ok);
  });

  it("claim/release exclusivity holds in-process (unit semantics)", () => {
    const pools = createSharedPools([100], 2);
    assert.equal(tryClaim(pools, 0, 5), true, "first claim wins");
    assert.equal(tryClaim(pools, 0, 7), false, "second claim loses while held");
    assert.equal(release(pools, 0, 7), false, "non-owner release fails");
    assert.equal(tryClaim(pools, 0, 7), false, "still held after failed release");
    assert.equal(release(pools, 0, 5), true, "owner release succeeds");
    assert.equal(tryClaim(pools, 0, 7), true, "free again after release");
    assert.equal(release(pools, 0, 7), true);
  });

  it("harvest fails cleanly on insufficient stock; deposit restores it", () => {
    const pools = createSharedPools([5], 0);
    assert.equal(tryHarvest(pools, 0, 6), false);
    assert.equal(tryHarvest(pools, 0, 5), true);
    assert.equal(tryHarvest(pools, 0, 1), false, "drained");
    deposit(pools, 0, 3);
    assert.equal(tryHarvest(pools, 0, 3), true);
    assert.deepEqual(
      [pools.words[pools.offsets.pools], pools.words[pools.offsets.harvested]],
      [0, 5],
      "remaining + netHarvested == initial",
    );
  });

  it("attachSharedPools rejects a malformed buffer", () => {
    assert.throws(
      () => attachSharedPools(new SharedArrayBuffer(64)),
      /bad header/,
    );
    const pools = createSharedPools([10], 1);
    assert.equal(attachSharedPools(pools.sab).poolCount, 1);
  });

  it("single-threaded baseline reconciles with the same op sequences", () => {
    const base = runContentionSingleThreaded({
      totalActors: 256,
      opsPerActor: 500,
      pools: [10_000, 10_000, 10_000, 10_000],
      resources: 32,
      seed: 0x5ab4,
      mode: "atomic",
    });
    assert.equal(base.totalOps, 256 * 500);
    assert.equal(base.releaseViolations, 0);
    assert.ok(base.reconcile.ok);
    assert.ok(base.opsPerSec > 0);
  });

  it("a real bitECS component SAB store is shared memory with a worker", async () => {
    const world = createWorld();
    const e = addEntity(world);
    addComponent(world, Transform, e);
    Transform.px[e] = 1.5;
    // Transform.px is a Float32Array view into the component's SAB.
    assert.ok(Transform.px.buffer instanceof SharedArrayBuffer);
    const byteOffset = Transform.px.byteOffset + e * Float32Array.BYTES_PER_ELEMENT;

    const reply = await new Promise<{ readBefore: number; readAfter: number }>(
      (resolvePromise, rejectPromise) => {
        const worker = new Worker(
          new URL("../src/sab-probe-worker.js", import.meta.url),
          {
            workerData: {
              sab: Transform.px.buffer,
              byteOffset,
              kind: "f32",
              value: 42.25,
            },
          },
        );
        worker.on("message", (msg) => {
          void worker.terminate();
          resolvePromise(msg);
        });
        worker.on("error", (err) => {
          void worker.terminate();
          rejectPromise(err);
        });
      },
    );
    // The worker observed the main thread's write through shared memory…
    assert.equal(reply.readBefore, 1.5);
    // …and the main thread observes the worker's write through its own
    // bitECS view — same memory, no copy.
    assert.equal(reply.readAfter, 42.25);
    assert.equal(Transform.px[e], 42.25);
  });
});
