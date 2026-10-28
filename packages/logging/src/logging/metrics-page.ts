/**
 * SAB Logging Layer — Metrics Sink counter page (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * A small SharedArrayBuffer of atomic counters. The Log Worker is the only
 * writer; the edge `/metrics` endpoint (or any thread) reads with
 * `Atomics.load`. No new endpoint shape: `renderLogMetrics()` emits
 * Prometheus text exposition that merges with the existing registry output.
 *
 * Layout (Int32 words):
 *   0   magic
 *   1   total records consumed
 *   2   drops observed on the ring (mirror of the header drop counter)
 *   3   flush count
 *   4   file bytes written (low 31 bits, wraps)
 *   5   worker heartbeat (monotonic, bumped every pump turn)
 *   6   sink error count
 *   7   worker stopped flag (orderly-shutdown handshake)
 *   8..12   per-level record counters (TRACE..ERROR)
 *   16..    per-code table: CODE_SLOTS pairs of [code+1, count]
 */

export const METRICS_MAGIC = 0x4c4d4531; // "LME1"
const W_MAGIC = 0;
const W_TOTAL = 1;
const W_DROPPED = 2;
const W_FLUSHES = 3;
const W_FILE_BYTES = 4;
const W_HEARTBEAT = 5;
const W_SINK_ERRORS = 6;
const W_STOPPED = 7;
const W_LEVEL_BASE = 8;
const W_CODE_BASE = 16;
export const CODE_SLOTS = 256;
export const METRICS_PAGE_WORDS = W_CODE_BASE + CODE_SLOTS * 2;
export const METRICS_PAGE_BYTES = METRICS_PAGE_WORDS * 4;

const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error"] as const;

export class LogMetricsPage {
  public readonly sab: SharedArrayBuffer;
  private readonly w: Int32Array;

  constructor(existing?: SharedArrayBuffer) {
    this.sab = existing ?? new SharedArrayBuffer(METRICS_PAGE_BYTES);
    this.w = new Int32Array(this.sab);
    if (!existing) Atomics.store(this.w, W_MAGIC, METRICS_MAGIC);
  }

  // ---- writer side (Log Worker only) ----

  public recordConsumed(level: number, code: number): void {
    Atomics.add(this.w, W_TOTAL, 1);
    if (level >= 0 && level < LEVEL_NAMES.length) Atomics.add(this.w, W_LEVEL_BASE + level, 1);
    // Open-addressed code table; sole writer, so plain probe + atomic publish.
    const key = (code & 0xffff) + 1;
    let slot = ((code * 2654435761) >>> 0) % CODE_SLOTS;
    for (let i = 0; i < CODE_SLOTS; i++) {
      const base = W_CODE_BASE + slot * 2;
      const k = Atomics.load(this.w, base);
      if (k === key) { Atomics.add(this.w, base + 1, 1); return; }
      if (k === 0) {
        Atomics.store(this.w, base + 1, 1);
        Atomics.store(this.w, base, key);
        return;
      }
      slot = (slot + 1) % CODE_SLOTS;
    }
    // Table full: count is still in total/level; per-code is best-effort.
  }

  public setDropped(n: number): void { Atomics.store(this.w, W_DROPPED, n | 0); }
  public recordFlush(bytes: number): void {
    Atomics.add(this.w, W_FLUSHES, 1);
    Atomics.add(this.w, W_FILE_BYTES, bytes | 0);
  }
  public recordSinkError(): void { Atomics.add(this.w, W_SINK_ERRORS, 1); }
  public heartbeat(): void { Atomics.add(this.w, W_HEARTBEAT, 1); }

  /** Orderly-shutdown handshake: the worker sets this after its final flush. */
  public markStopped(): void {
    Atomics.store(this.w, W_STOPPED, 1);
    Atomics.notify(this.w, W_STOPPED);
  }
  public clearStopped(): void { Atomics.store(this.w, W_STOPPED, 0); }
  public get stopped(): boolean { return Atomics.load(this.w, W_STOPPED) === 1; }
  /** Block (Atomics.wait) until the worker marks itself stopped, or the timeout. Shutdown path only. */
  public waitStopped(timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      Atomics.wait(this.w, W_STOPPED, 0, left);
    }
    return true;
  }

  // ---- reader side (any thread) ----

  public get total(): number { return Atomics.load(this.w, W_TOTAL); }
  public get dropped(): number { return Atomics.load(this.w, W_DROPPED); }
  public get flushes(): number { return Atomics.load(this.w, W_FLUSHES); }
  public get fileBytes(): number { return Atomics.load(this.w, W_FILE_BYTES); }
  public get heartbeatCount(): number { return Atomics.load(this.w, W_HEARTBEAT); }
  public get sinkErrors(): number { return Atomics.load(this.w, W_SINK_ERRORS); }
  public levelCount(level: number): number { return Atomics.load(this.w, W_LEVEL_BASE + level); }

  public codeCount(code: number): number {
    const key = (code & 0xffff) + 1;
    let slot = ((code * 2654435761) >>> 0) % CODE_SLOTS;
    for (let i = 0; i < CODE_SLOTS; i++) {
      const base = W_CODE_BASE + slot * 2;
      const k = Atomics.load(this.w, base);
      if (k === key) return Atomics.load(this.w, base + 1);
      if (k === 0) return 0;
      slot = (slot + 1) % CODE_SLOTS;
    }
    return 0;
  }

  /** Prometheus text exposition, mergeable with the edge registry's output. */
  public renderLogMetrics(): string {
    const lines: string[] = [];
    lines.push("# HELP mmo_log_records_total Log records consumed by the log worker, by level.");
    lines.push("# TYPE mmo_log_records_total counter");
    for (let l = 0; l < LEVEL_NAMES.length; l++) {
      lines.push(`mmo_log_records_total{level="${LEVEL_NAMES[l]}"} ${this.levelCount(l)}`);
    }
    lines.push("# HELP mmo_log_dropped_total Log records dropped because the ring was full.");
    lines.push("# TYPE mmo_log_dropped_total counter");
    lines.push(`mmo_log_dropped_total ${this.dropped}`);
    lines.push("# HELP mmo_log_flushes_total File sink flushes.");
    lines.push("# TYPE mmo_log_flushes_total counter");
    lines.push(`mmo_log_flushes_total ${this.flushes}`);
    lines.push("# HELP mmo_log_file_bytes_total Bytes written by the file sink.");
    lines.push("# TYPE mmo_log_file_bytes_total counter");
    lines.push(`mmo_log_file_bytes_total ${this.fileBytes}`);
    lines.push("# HELP mmo_log_sink_errors_total Sink write failures (the ring is never backpressured).");
    lines.push("# TYPE mmo_log_sink_errors_total counter");
    lines.push(`mmo_log_sink_errors_total ${this.sinkErrors}`);
    lines.push("# HELP mmo_log_worker_heartbeat Monotonic worker liveness counter.");
    lines.push("# TYPE mmo_log_worker_heartbeat counter");
    lines.push(`mmo_log_worker_heartbeat ${this.heartbeatCount}`);
    lines.push("# HELP mmo_log_code_total Log records consumed, by dictionary code.");
    lines.push("# TYPE mmo_log_code_total counter");
    for (let s = 0; s < CODE_SLOTS; s++) {
      const base = W_CODE_BASE + s * 2;
      const k = Atomics.load(this.w, base);
      if (k !== 0) {
        lines.push(`mmo_log_code_total{code="0x${(k - 1).toString(16).padStart(4, "0")}"} ${Atomics.load(this.w, base + 1)}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
