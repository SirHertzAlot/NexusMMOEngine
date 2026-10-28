/**
 * SAB Logging Layer — Log Worker supervisor (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * Spawns the log worker thread and restarts it if it dies. Crash behavior
 * per spec: worker death loses in-flight records and nothing else — the
 * ring keeps accepting (or counting drops), producers never notice, and a
 * restarted worker resumes from the dequeue index left in the SAB header.
 * Everything here runs off the tick path.
 */
import { Worker } from "node:worker_threads";
import { LogRingBuffer } from "./log-ring.js";
import { LogMetricsPage } from "./metrics-page.js";
import { FileSink } from "./file-sink.js";
import { LogWorkerCore } from "./log-worker-core.js";
import type { LogWorkerData } from "./log-worker-thread.js";

export interface LogWorkerSupervisorOptions {
  ring: LogRingBuffer;
  metrics?: LogMetricsPage;
  logDir: string;
  baseName?: string;
  maxBytes?: number;
  maxFiles?: number;
  flushBytes?: number;
  flushMs?: number;
  /** Restart backoff, doubled per consecutive crash. Defaults 50 ms .. 5 s. */
  restartBackoffMs?: number;
  maxBackoffMs?: number;
  /** Test seam: override the worker script URL. */
  workerUrl?: URL;
}

export class LogWorkerSupervisor {
  public readonly ring: LogRingBuffer;
  public readonly metrics: LogMetricsPage;
  public restarts = 0;
  private worker: Worker | null = null;
  private stopping = false;
  private backoff: number;
  private readonly opts: LogWorkerSupervisorOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: LogWorkerSupervisorOptions) {
    this.opts = opts;
    this.ring = opts.ring;
    this.metrics = opts.metrics ?? new LogMetricsPage();
    this.backoff = opts.restartBackoffMs ?? 50;
  }

  public start(): Promise<void> {
    return this.spawn();
  }

  private spawn(): Promise<void> {
    const url = this.opts.workerUrl ?? new URL("./log-worker-thread.js", import.meta.url);
    const data: LogWorkerData = {
      ringSab: this.ring.sab,
      ringCapacity: this.ring.capacity,
      metricsSab: this.metrics.sab,
      logDir: this.opts.logDir,
      baseName: this.opts.baseName,
      maxBytes: this.opts.maxBytes,
      maxFiles: this.opts.maxFiles,
      flushBytes: this.opts.flushBytes,
      flushMs: this.opts.flushMs,
    };
    const w = new Worker(url, { workerData: data });
    this.worker = w;
    return new Promise<void>((resolve) => {
      let resolved = false;
      w.on("message", (m: unknown) => {
        if (m === "ready") {
          this.backoff = this.opts.restartBackoffMs ?? 50;
          if (!resolved) { resolved = true; resolve(); }
        }
      });
      w.on("error", () => { /* surfaced via exit; the tick must not care */ });
      w.on("exit", () => {
        if (this.worker === w) this.worker = null;
        if (!resolved) { resolved = true; resolve(); }
        if (this.stopping) return;
        this.restarts++;
        const wait = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 5000);
        this.timer = setTimeout(() => { void this.spawn(); }, wait);
        this.timer.unref();
      });
    });
  }

  /** Test/ops hook: kill the worker abruptly, as a crash would. */
  public async killForDrill(): Promise<void> {
    await this.worker?.terminate();
  }

  public get alive(): boolean { return this.worker !== null; }

  /**
   * Synchronous orderly stop for the process-exit path (SIGTERM handler runs
   * save -> onSaved -> process.exit(0), all synchronous, so the async stop()
   * would lose the last batch — including the shutdown line itself).
   *
   * Blocks (Atomics.wait on the metrics page) until the worker has done its
   * final drain+flush, then drains any stragglers in-process. If the worker is
   * already dead (crashed, restart pending) the in-process drain does the whole
   * job, so shutdown never depends on the worker being healthy.
   */
  public stopSync(timeoutMs = 1500): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const w = this.worker;
    if (w) {
      this.metrics.clearStopped();
      w.postMessage("stop");
      this.metrics.waitStopped(timeoutMs);
    }
    this.drainInProcess();
  }

  private drainInProcess(): void {
    const file = new FileSink({
      dir: this.opts.logDir,
      baseName: this.opts.baseName,
      maxBytes: this.opts.maxBytes,
      maxFiles: this.opts.maxFiles,
    });
    const core = new LogWorkerCore({ ring: this.ring, file, metrics: this.metrics, flushMs: 0 });
    core.stop();
  }

  /** Orderly stop: worker drains to empty, flushes, closes the file. */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const w = this.worker;
    if (!w) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { void w.terminate().then(() => resolve()); }, 2000);
      w.once("exit", () => { clearTimeout(t); resolve(); });
      w.postMessage("stop");
    });
  }
}
