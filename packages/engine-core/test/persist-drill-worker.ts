/**
 * Worker host for the §7 persist drill.
 *
 * Runs the embedded SurrealDB engine (`mem://`) inside this worker thread so it
 * can be terminated at the end of the test instead of leaving its native event
 * loop alive in the main process. Every SurrealDB operation is proxied over
 * `parentPort` messages; the test drives the shared SAB transaction ring
 * directly and only asks the worker to drain + query.
 */
import { parentPort, workerData } from "node:worker_threads";
import { PersistenceWorkerRuntime } from "../src/persist-worker.js";

type DrillMsg =
  | { type: "init" }
  | { type: "drain" }
  | { type: "entity"; sabIndex: number }
  | { type: "inventory"; sabIndex: number }
  | { type: "query"; id: string; sql: string }
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

parentPort?.on("message", (msg: DrillMsg) => {
  switch (msg.type) {
    case "drain": {
      void runtime.drainPendingTransactions().then((count) => {
        parentPort?.postMessage({ type: "drained", count });
      });
      break;
    }
    case "entity": {
      void runtime.getEntityBySabIndex(msg.sabIndex).then((row) => {
        parentPort?.postMessage({ type: "entity", sabIndex: msg.sabIndex, row: JSON.stringify(row) });
      });
      break;
    }
    case "inventory": {
      void runtime.getOwnedInventory(msg.sabIndex).then((rows) => {
        parentPort?.postMessage({ type: "inventory", sabIndex: msg.sabIndex, rows: JSON.stringify(rows) });
      });
      break;
    }
    case "query": {
      void (async () => {
        try {
          const rows = await runtime.db.query(msg.sql);
          parentPort?.postMessage({ type: "query", id: msg.id, ok: true, rows: JSON.stringify(rows) });
        } catch (e) {
          parentPort?.postMessage({ type: "query", id: msg.id, ok: false, error: String(e) });
        }
      })();
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
