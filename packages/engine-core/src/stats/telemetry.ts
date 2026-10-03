/**
 * PlayTelemetry — what players did, in fixed time buckets (T2).
 *
 * Counters live in preallocated Float64Arrays, one slot per bucket
 * (`BUCKET_SECONDS` wide, `BUCKETS` of them, a ring), so recording is an
 * index and an add: no allocation in the tick. Tick durations go in a fixed
 * histogram for p50/p99. Reading (`snapshot`) allocates, and is only for the
 * editor graphs and the admin command, never the tick.
 */

export const BUCKET_SECONDS = 10;
export const BUCKETS = 60;

export type CounterName = "kills" | "deaths" | "pickups" | "drops" | "damageDealt" | "damageTaken";
const NAMES: readonly CounterName[] = ["kills", "deaths", "pickups", "drops", "damageDealt", "damageTaken"];
const N = NAMES.length;

/** Tick duration histogram: 0.5 ms bins up to 40 ms, last bin catches the rest. */
const HIST_BIN_MS = 0.5;
const HIST_BINS = 81;

export interface TelemetrySnapshot {
  bucketSeconds: number;
  /** Oldest first; the last bucket is the one filling now. */
  buckets: number;
  series: Record<CounterName, number[]>;
  totals: Record<CounterName, number>;
  tick: { count: number; p50Ms: number; p99Ms: number; maxMs: number };
}

export class PlayTelemetry {
  private readonly data = new Float64Array(N * BUCKETS);
  private readonly hist = new Uint32Array(HIST_BINS);
  private readonly totalsArr = new Float64Array(N);
  private histCount = 0;
  private maxMs = 0;
  private head = 0; // index of the bucket being filled
  private headStart: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.headStart = clock();
  }

  /** Move the ring forward to the bucket that holds `now`, clearing what it passes. */
  private roll(): void {
    const now = this.clock();
    let steps = Math.floor((now - this.headStart) / (BUCKET_SECONDS * 1000));
    if (steps <= 0) return;
    this.headStart += steps * BUCKET_SECONDS * 1000;
    if (steps > BUCKETS) steps = BUCKETS;
    for (let i = 0; i < steps; i++) {
      this.head = (this.head + 1) % BUCKETS;
      const base = this.head * N;
      for (let c = 0; c < N; c++) this.data[base + c] = 0;
    }
  }

  private add(c: number, n: number): void {
    this.roll();
    this.data[this.head * N + c] += n;
    this.totalsArr[c] += n;
  }

  kill(): void { this.add(0, 1); }
  death(): void { this.add(1, 1); }
  pickup(): void { this.add(2, 1); }
  drop(): void { this.add(3, 1); }
  damageDealt(n: number): void { this.add(4, n); }
  damageTaken(n: number): void { this.add(5, n); }

  /** One tick's wall time. */
  tickMs(ms: number): void {
    let bin = Math.floor(ms / HIST_BIN_MS);
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    if (bin < 0) bin = 0;
    this.hist[bin]++;
    this.histCount++;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  private quantile(q: number): number {
    if (this.histCount === 0) return 0;
    const want = Math.ceil(this.histCount * q);
    let seen = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      seen += this.hist[i];
      if (seen >= want) return (i + 1) * HIST_BIN_MS;
    }
    return HIST_BINS * HIST_BIN_MS;
  }

  snapshot(): TelemetrySnapshot {
    this.roll();
    const series = {} as Record<CounterName, number[]>;
    const totals = {} as Record<CounterName, number>;
    for (let c = 0; c < N; c++) {
      const s: number[] = [];
      for (let i = 1; i <= BUCKETS; i++) s.push(this.data[((this.head + i) % BUCKETS) * N + c]);
      series[NAMES[c]] = s;
      totals[NAMES[c]] = this.totalsArr[c];
    }
    return {
      bucketSeconds: BUCKET_SECONDS,
      buckets: BUCKETS,
      series,
      totals,
      tick: { count: this.histCount, p50Ms: this.quantile(0.5), p99Ms: this.quantile(0.99), maxMs: this.maxMs },
    };
  }
}
