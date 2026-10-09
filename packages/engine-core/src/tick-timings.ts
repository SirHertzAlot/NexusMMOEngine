/**
 * Per-tick timing tracker for the world server.
 * Keeps a bounded history of tick durations and per-system costs;
 * the debug API serves snapshots to the editor's Debug workspace.
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

export class TickTimings {
  private durations: number[] = [];
  private systemTotals = new Map<string, { sum: number; max: number; n: number }>();

  constructor(private readonly maxHistory = 1000) {}

  /** Record one tick: its total duration and per-system breakdown (ms). */
  recordTick(durationMs: number, systems: Record<string, number>): void {
    this.durations.push(durationMs);
    if (this.durations.length > this.maxHistory) this.durations.shift();
    for (const [name, ms] of Object.entries(systems)) {
      const cur = this.systemTotals.get(name) ?? { sum: 0, max: 0, n: 0 };
      cur.sum += ms;
      cur.max = Math.max(cur.max, ms);
      cur.n++;
      this.systemTotals.set(name, cur);
    }
  }

  snapshot(): TimingSnapshot {
    const ticks = this.durations.length;
    if (ticks === 0) return { ticks: 0, p50: 0, p99: 0, systems: [] };
    const sorted = [...this.durations].sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const systems: SystemCost[] = [...this.systemTotals.entries()]
      .map(([name, { sum, max, n }]) => ({ name, avg: sum / n, max }))
      .sort((a, b) => b.avg - a.avg);
    return { ticks, p50: pct(50), p99: pct(99), systems };
  }

  /** Clear history (e.g. on world reset). */
  reset(): void {
    this.durations = [];
    this.systemTotals.clear();
  }
}
