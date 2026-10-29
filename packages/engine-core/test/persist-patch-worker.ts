/**
 * Worker host for the PATCH-04 persist drill.
 *
 * Runs the embedded SurrealDB engine (`mem://`) inside this worker thread so it
 * can be terminated at the end of the test instead of leaving its native event
 * loop alive in the main process (which forces the whole suite to run with
 * `--test-force-exit`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { PersistenceWorkerRuntime } from "../src/persist-worker.js";

type PatchMsg =
  | { type: "init" }
  | { type: "flushOnce"; limit: number }
  | { type: "entity"; sabIndex: number }
  | { type: "stop" };

const runtime = new PersistenceWorkerRuntime({
  sharedMemory: workerData.sharedMemory as SharedArrayBuffer,
  entityCapacity: workerData.entityCapacity as number,
  persistRingCapacity: workerData.persistRingCapacity as number | undefined,
  dbUrl: workerData.dbUrl as string,
  namespace: workerData.namespace as string | undefined,
  database: workerData.database as string | undefined,
});

await runtime.init();
parentPort?.postMessage({ type: "ready" });

parentPort?.on("message", (msg: PatchMsg) => {
  switch (msg.type) {
    case "flushOnce": {
      void runtime.flushOnce(msg.limit).then((processed) => {
        parentPort?.postMessage({ type: "flushed", processed });
      });
      break;
    }
    case "entity": {
      void runtime.getEntityBySabIndex(msg.sabIndex).then((row) => {
        parentPort?.postMessage({ type: "entity", sabIndex: msg.sabIndex, row: JSON.stringify(row) });
      });
      break;
    }
    case "stop": {
      void runtime.stop().then(() => {
        parentPort?.postMessage({ type: "stopped" });
      });
      break;
    }
  }
});
