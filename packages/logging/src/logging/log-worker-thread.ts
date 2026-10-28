/**
 * SAB Logging Layer — worker_thread entry (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * Hosts a LogWorkerCore on a dedicated thread. Spawned by `supervisor.ts`;
 * not imported by anything on the tick path.
 */
import { parentPort, workerData } from "node:worker_threads";
import { LogRingBuffer } from "./log-ring.js";
import { LogMetricsPage } from "./metrics-page.js";
import { FileSink } from "./file-sink.js";
import { LogWorkerCore } from "./log-worker-core.js";

export interface LogWorkerData {
  ringSab: SharedArrayBuffer;
  ringCapacity: number;
  metricsSab: SharedArrayBuffer;
  logDir: string;
  baseName?: string;
  maxBytes?: number;
  maxFiles?: number;
  flushBytes?: number;
  flushMs?: number;
}

if (parentPort) {
  const d = workerData as LogWorkerData;
  const ring = new LogRingBuffer(d.ringCapacity, d.ringSab);
  const metrics = new LogMetricsPage(d.metricsSab);
  const file = new FileSink({ dir: d.logDir, baseName: d.baseName, maxBytes: d.maxBytes, maxFiles: d.maxFiles });
  const core = new LogWorkerCore({ ring, file, metrics, flushBytes: d.flushBytes, flushMs: d.flushMs });

  let running = true;
  const loop = (): void => {
    if (!running) return;
    const n = core.pump();
    // Full batch: more is waiting, go again immediately. Idle: back off 1 ms.
    if (n >= 4096) setImmediate(loop);
    else setTimeout(loop, n > 0 ? 0 : 1);
  };

  parentPort.on("message", (msg: unknown) => {
    if (msg === "stop") {
      running = false;
      core.stop();
      metrics.markStopped();
      parentPort!.postMessage("stopped");
      process.exit(0);
    }
  });
  parentPort.postMessage("ready");
  loop();
}
