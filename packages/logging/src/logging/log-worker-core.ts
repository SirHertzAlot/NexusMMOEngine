/**
 * SAB Logging Layer — Log Worker core (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * Owns the ring's dequeue end. Each `pump()` turn: drain what is available
 * (bounded), format once via the generated LOG_FORMATTERS table, stage into
 * the file sink, update the metrics page, and flush on size (64 KiB) or
 * time (50 ms) — whichever first. Formatting happens here, never on a
 * producer. Records nobody reads are the common case and cost nothing but
 * the ring write.
 *
 * The core is transport-agnostic (plain class) so it is unit-testable
 * in-process; `log-worker-thread.ts` hosts it on a worker_thread and
 * `supervisor.ts` restarts it if it dies.
 */
import { LogLevel } from "./log-codes.js";
import { LOG_FORMATTERS } from "./generated/log-formatters.js";
import type { LogRecordView } from "./log-record.js";
import type { LogRingBuffer } from "./log-ring.js";
import type { FileSink } from "./file-sink.js";
import type { LogMetricsPage } from "./metrics-page.js";

const LEVEL_TAG = ["TRACE", "DEBUG", "INFO ", "WARN ", "ERROR"] as const;
const PRODUCER_TAG = ["gateway", "sim", "persist", "world", "native", "client", "admin"] as const;

export interface LogWorkerCoreOptions {
  ring: LogRingBuffer;
  file?: FileSink;
  metrics?: LogMetricsPage;
  /** Extra consumer of each formatted batch (Phase 3 live sink hooks in here). */
  onBatch?: (text: string, records: number) => void;
  flushBytes?: number;
  flushMs?: number;
  maxDrainPerTurn?: number;
  /** Test seam. */
  now?: () => number;
}

export class LogWorkerCore {
  private readonly ring: LogRingBuffer;
  private readonly file?: FileSink;
  private readonly metrics?: LogMetricsPage;
  private readonly onBatch?: (text: string, records: number) => void;
  private readonly flushBytes: number;
  private readonly flushMs: number;
  private readonly maxDrain: number;
  private readonly now: () => number;

  private batchRecords = 0;
  private batchBytes = 0;
  private batchText: string[] = [];
  private lastFlushAt: number;

  public consumed = 0;

  constructor(opts: LogWorkerCoreOptions) {
    this.ring = opts.ring;
    this.file = opts.file;
    this.metrics = opts.metrics;
    this.onBatch = opts.onBatch;
    this.flushBytes = opts.flushBytes ?? 64 * 1024;
    this.flushMs = opts.flushMs ?? 50;
    this.maxDrain = opts.maxDrainPerTurn ?? 4096;
    this.now = opts.now ?? (() => performance.now());
    this.lastFlushAt = this.now();
  }

  /** Render one record as a single text line. Pure; exported for the replay tool. */
  public static formatRecord(rec: LogRecordView): string {
    const wallMs = Number(rec.timestampNs) / 1e6;
    const iso = new Date(wallMs).toISOString();
    const lvl = LEVEL_TAG[rec.level] ?? `L${rec.level}`;
    const prod = PRODUCER_TAG[rec.producer] ?? `p${rec.producer}`;
    const fmt = LOG_FORMATTERS.get(rec.code);
    const body = fmt
      ? fmt(rec)
      : `unknown code 0x${rec.code.toString(16).padStart(4, "0")} args=${JSON.stringify(rec.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    const tick = rec.tick ? ` t=${rec.tick}` : "";
    return `${iso} ${lvl} ${prod}${tick} ${body}`;
  }

  /**
   * One worker turn. Returns the number of records drained so the host
   * loop can spin (full batch) or sleep (idle).
   */
  public pump(): number {
    this.metrics?.heartbeat();
    const n = this.ring.drain((rec) => {
      this.metrics?.recordConsumed(rec.level, rec.code);
      const line = LogWorkerCore.formatRecord(rec);
      this.batchRecords++;
      this.batchBytes += line.length + 1;
      if (this.file) this.file.append(line);
      if (this.onBatch) this.batchText.push(line);
    }, this.maxDrain);
    this.consumed += n;
    this.metrics?.setDropped(this.ring.droppedCount);

    const due =
      this.batchBytes >= this.flushBytes ||
      (this.batchRecords > 0 && this.now() - this.lastFlushAt >= this.flushMs);
    if (due) this.flush();
    return n;
  }

  /** Flush sinks now (size/time boundary, or shutdown). */
  public flush(): void {
    if (this.file) {
      const before = this.file.errors;
      const bytes = this.file.flush();
      if (this.file.errors > before) this.metrics?.recordSinkError();
      if (bytes > 0) this.metrics?.recordFlush(bytes);
    }
    if (this.onBatch && this.batchRecords > 0) {
      try {
        this.onBatch(this.batchText.join("\n"), this.batchRecords);
      } catch {
        this.metrics?.recordSinkError();
      }
    }
    this.batchText = [];
    this.batchRecords = 0;
    this.batchBytes = 0;
    this.lastFlushAt = this.now();
  }

  /** Final drain + flush; call on orderly shutdown. */
  public stop(): void {
    while (this.pump() > 0) { /* drain to empty */ }
    this.flush();
    this.file?.close();
  }

  /** ERROR is never maskable; exposed so admin tooling can show the floor. */
  public static readonly UNMASKABLE_LEVEL = LogLevel.ERROR;
}
