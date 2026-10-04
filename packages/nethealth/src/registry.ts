/**
 * Metrics registry (slice E6 of docs/EDGE-CORE-SPLIT.md): counters, gauges
 * and histograms, labelled, scraped as Prometheus text.
 *
 * Histograms keep fixed millisecond buckets: Prometheus' text format is
 * bucketed anyway, so an HDR histogram underneath would buy nothing the
 * scrape could show. (The plan named `hdrhistogram-js`; no such MIT package
 * exists, and `hdr-histogram-js` would be a dependency for no gain.)
 */
import { serialize } from "./prometheus.js";

export type Labels = Record<string, string>;
export type MetricType = "counter" | "gauge" | "histogram";

/** Upper bounds, ms; +Inf is implied. */
export const DEFAULT_BUCKETS_MS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 33.3, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function labelKey(names: readonly string[], labels: Labels | undefined): string {
  const given = labels ?? {};
  for (const k of Object.keys(given)) if (!names.includes(k)) throw new Error(`unknown label "${k}" (have ${names.join(", ") || "none"})`);
  return JSON.stringify(names.map((n) => {
    const v = given[n];
    if (v === undefined) throw new Error(`missing label "${n}"`);
    return String(v);
  }));
}

abstract class Metric<S> {
  readonly series = new Map<string, S>();
  constructor(readonly name: string, readonly help: string, readonly labelNames: readonly string[], readonly type: MetricType) {}
  protected at(labels: Labels | undefined, make: () => S): S {
    const k = labelKey(this.labelNames, labels);
    let s = this.series.get(k);
    if (!s) { s = make(); this.series.set(k, s); }
    return s;
  }
  /** The label values of a series key, in labelNames order. */
  labelsOf(key: string): Labels {
    const values = JSON.parse(key) as string[];
    const out: Labels = {};
    this.labelNames.forEach((n, i) => { out[n] = values[i]; });
    return out;
  }
}

export class Counter extends Metric<{ value: number }> {
  constructor(name: string, help: string, labelNames: readonly string[]) { super(name, help, labelNames, "counter"); if (labelNames.length === 0) this.at(undefined, () => ({ value: 0 })); }
  inc(labels?: Labels, by = 1): void {
    if (by < 0) throw new Error("counters only go up");
    this.at(labels, () => ({ value: 0 })).value += by;
  }
  get(labels?: Labels): number { return this.series.get(labelKey(this.labelNames, labels))?.value ?? 0; }
}

export class Gauge extends Metric<{ value: number }> {
  constructor(name: string, help: string, labelNames: readonly string[]) { super(name, help, labelNames, "gauge"); if (labelNames.length === 0) this.at(undefined, () => ({ value: 0 })); }
  set(value: number, labels?: Labels): void { this.at(labels, () => ({ value: 0 })).value = value; }
  inc(labels?: Labels, by = 1): void { this.at(labels, () => ({ value: 0 })).value += by; }
  dec(labels?: Labels, by = 1): void { this.at(labels, () => ({ value: 0 })).value -= by; }
  get(labels?: Labels): number { return this.series.get(labelKey(this.labelNames, labels))?.value ?? 0; }
}

export interface HistogramSeries { counts: number[]; sum: number; count: number; }

export class Histogram extends Metric<HistogramSeries> {
  constructor(name: string, help: string, labelNames: readonly string[], readonly buckets: readonly number[] = DEFAULT_BUCKETS_MS) {
    super(name, help, labelNames, "histogram");
    if (labelNames.length === 0) this.at(undefined, () => this.empty());
  }
  private empty(): HistogramSeries { return { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }; }
  observe(valueMs: number, labels?: Labels): void {
    if (!Number.isFinite(valueMs)) return;
    const s = this.at(labels, () => this.empty());
    for (let i = 0; i < this.buckets.length; i++) if (valueMs <= this.buckets[i]) { s.counts[i]++; break; }
    s.sum += valueMs;
    s.count++;
  }
  /** Time `fn` and observe it. */
  time<T>(labels: Labels | undefined, fn: () => T): T {
    const t0 = performance.now();
    try { return fn(); } finally { this.observe(performance.now() - t0, labels); }
  }
}

export class Registry {
  private readonly metrics = new Map<string, Counter | Gauge | Histogram>();

  constructor(readonly prefix = "") {}

  counter(name: string, help: string, labels: string[] = []): Counter { return this.add(new Counter(this.full(name), help, this.check(labels))); }
  gauge(name: string, help: string, labels: string[] = []): Gauge { return this.add(new Gauge(this.full(name), help, this.check(labels))); }
  histogram(name: string, help: string, labels: string[] = [], buckets?: readonly number[]): Histogram { return this.add(new Histogram(this.full(name), help, this.check(labels), buckets)); }

  /** Every registered metric name (with prefix). */
  names(): string[] { return [...this.metrics.keys()]; }
  get(name: string): Counter | Gauge | Histogram | undefined { return this.metrics.get(name); }
  all(): Array<Counter | Gauge | Histogram> { return [...this.metrics.values()]; }

  scrape(): string { return serialize(this.all()); }

  private full(name: string): string {
    const n = this.prefix + name;
    if (!NAME_RE.test(n)) throw new Error(`invalid metric name "${n}"`);
    return n;
  }
  private check(labels: string[]): string[] {
    for (const l of labels) if (!LABEL_RE.test(l) || l.startsWith("__")) throw new Error(`invalid label name "${l}"`);
    return labels;
  }
  private add<M extends Counter | Gauge | Histogram>(m: M): M {
    if (this.metrics.has(m.name)) throw new Error(`metric "${m.name}" registered twice`);
    this.metrics.set(m.name, m);
    return m;
  }
}
