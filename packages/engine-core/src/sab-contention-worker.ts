/**
 * Contention worker for sab-contention.ts.
 *
 * Receives the main thread's SharedArrayBuffer via workerData (shared by
 * reference — no copy), attaches to it, runs its slice of the actor
 * workload, and posts one ContentionWorkerResult back. The main thread
 * terminates the worker after the result arrives.
 *
 * Protocol (from runContention): workerData ContentionWorkerData ->
 * one ContentionWorkerResult message, then idle until terminated.
 */

import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import {
  attachSharedPools,
  runActorWorkload,
  type ContentionWorkerData,
  type ContentionWorkerResult,
} from "./sab-contention.js";

if (parentPort) {
  const data = workerData as ContentionWorkerData;
  const pools = attachSharedPools(data.sab);
  const t0 = performance.now();
  const stats = runActorWorkload(
    pools,
    data.actorStart,
    data.actorCount,
    data.opsPerActor,
    data.seed,
    data.mode,
  );
  const result: ContentionWorkerResult = {
    workerIndex: data.workerIndex,
    wallMs: performance.now() - t0,
    ...stats,
  };
  parentPort.postMessage(result);
}
