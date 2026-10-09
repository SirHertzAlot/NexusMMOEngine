/**
 * Per-tick timing tracker for the world server.
 * Keeps a bounded history of tick durations and per-system costs;
 * the debug API serves snapshots to the editor's Debug workspace.
 *
 * Recording runs inside the tick, so it allocates nothing per tick: tick
 * durations go into a fixed ring and each system keeps running totals.
 */

export interface SystemCost {
  name: string;
  /** Mean milliseconds per tick. */
  avg: number;
  /** Max milliseconds in the window. */
  max: number;
}

export interface TimingSnapshot {
  ticks: number;
  /** Median tick duration, ms. */
  p50: number;
  /** 99th percentile tick duration, ms. */
  p99: number;
  /** Systems by mean cost, descending. */
  systems: SystemCost[];
}

interface SystemTotals {
  sum: number;
  max: number;
  n: number;
}

export class TickTimings {
  private readonly ring: Float64Array;
  private next = 0;
  private count = 0;
  private systemTotals = new Map<string, SystemTotals>();

  constructor(private readonly maxHistory = 1000) {
    this.ring = new Float64Array(Math.max(1, maxHistory));
  }

  /** One system's cost this tick (ms). Call for each system, then endTick. */
  recordSystem(name: string, ms: number): void {
    let cur = this.systemTotals.get(name);
    if (!cur) {
      cur = { sum: 0, max: 0, n: 0 };
      this.systemTotals.set(name, cur);
    }
    cur.sum += ms;
    if (ms > cur.max) cur.max = ms;
    cur.n++;
  }

  /** Close the tick with its total duration (ms). */
  endTick(durationMs: number): void {
    this.ring[this.next] = durationMs;
    this.next = (this.next + 1) % this.ring.length;
    if (this.count < this.ring.length) this.count++;
  }

  /** Record one tick: its total duration and per-system breakdown (ms). */
  recordTick(durationMs: number, systems: Record<string, number>): void {
    for (const [name, ms] of Object.entries(systems)) this.recordSystem(name, ms);
    this.endTick(durationMs);
  }

  snapshot(): TimingSnapshot {
    const ticks = this.count;
    if (ticks === 0) return { ticks: 0, p50: 0, p99: 0, systems: [] };
    const sorted = Array.from(this.ring.subarray(0, ticks)).sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const systems: SystemCost[] = [...this.systemTotals.entries()]
      .filter(([, { n }]) => n > 0)
      .map(([name, { sum, max, n }]) => ({ name, avg: sum / n, max }))
      .sort((a, b) => b.avg - a.avg);
    return { ticks, p50: pct(50), p99: pct(99), systems };
  }

  /** Clear history (e.g. on world reset). */
  reset(): void {
    this.next = 0;
    this.count = 0;
    this.systemTotals.clear();
  }
}
