/**
 * SAB Logging Layer — batched file sink (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * One `write` per flush of a pre-allocated buffer — never per-record
 * stream writes (the Snell rule). Size-based rotation:
 *   <base>.log -> <base>.1.log -> <base>.2.log ... (oldest dropped).
 * Runs on the Log Worker thread only; a failing disk increments the sink's
 * error counter and drops the batch — it can never backpressure the ring.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileSinkOptions {
  dir: string;
  baseName?: string;
  /** Rotate when the active file would exceed this many bytes. Default 10 MiB. */
  maxBytes?: number;
  /** Rotated files kept (excluding the active one). Default 5. */
  maxFiles?: number;
  /** Pre-allocated batch buffer. Default 128 KiB (> 64 KiB flush threshold). */
  bufferBytes?: number;
}

export class FileSink {
  private readonly dir: string;
  private readonly base: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly buf: Buffer;
  private used = 0;
  private fd: number | null = null;
  private fileSize = 0;
  public errors = 0;
  public rotations = 0;

  constructor(opts: FileSinkOptions) {
    this.dir = opts.dir;
    this.base = opts.baseName ?? "engine";
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
    this.buf = Buffer.allocUnsafe(opts.bufferBytes ?? 128 * 1024);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  public get activePath(): string { return path.join(this.dir, `${this.base}.log`); }
  private rotatedPath(i: number): string { return path.join(this.dir, `${this.base}.${i}.log`); }

  /** Bytes currently staged, not yet written. */
  public get pendingBytes(): number { return this.used; }

  /** Stage one formatted line (newline appended). Flushes early if the buffer is full. */
  public append(line: string): void {
    const need = Buffer.byteLength(line, "utf8") + 1;
    if (need > this.buf.length) {
      // Pathological single line: truncate rather than allocate.
      line = line.slice(0, this.buf.length - 2);
    }
    if (this.used + Buffer.byteLength(line, "utf8") + 1 > this.buf.length) this.flush();
    this.used += this.buf.write(line, this.used, "utf8");
    this.buf[this.used++] = 0x0a;
  }

  /** One batched write of everything staged. Returns bytes written (0 on none/error). */
  public flush(): number {
    if (this.used === 0) return 0;
    const n = this.used;
    this.used = 0;
    try {
      if (this.fd === null) this.open();
      if (this.fileSize + n > this.maxBytes && this.fileSize > 0) this.rotate();
      fs.writeSync(this.fd as number, this.buf, 0, n);
      this.fileSize += n;
      return n;
    } catch {
      this.errors++;
      this.closeQuiet();
      return 0;
    }
  }

  public close(): void {
    this.flush();
    this.closeQuiet();
  }

  private open(): void {
    this.fd = fs.openSync(this.activePath, "a");
    this.fileSize = fs.fstatSync(this.fd).size;
  }

  private closeQuiet(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  private rotate(): void {
    this.closeQuiet();
    // Shift N-1 -> N, ..., active -> 1; the oldest falls off.
    try { fs.rmSync(this.rotatedPath(this.maxFiles), { force: true }); } catch { /* ignore */ }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      try { fs.renameSync(this.rotatedPath(i), this.rotatedPath(i + 1)); } catch { /* absent */ }
    }
    if (this.maxFiles >= 1) {
      try { fs.renameSync(this.activePath, this.rotatedPath(1)); } catch { /* ignore */ }
    } else {
      try { fs.rmSync(this.activePath, { force: true }); } catch { /* ignore */ }
    }
    this.rotations++;
    this.open();
  }
}
