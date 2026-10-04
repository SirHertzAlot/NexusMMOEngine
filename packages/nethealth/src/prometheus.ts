/** Prometheus text exposition format 0.0.4. */
import type { Counter, Gauge, Histogram, Labels } from "./registry.js";

export const CONTENT_TYPE = "text/plain; version=0.0.4";

const escHelp = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escValue = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

export function renderLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escValue(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

export function formatNumber(v: number): string {
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  if (Number.isNaN(v)) return "NaN";
  return String(v);
}

export function serialize(metrics: ReadonlyArray<Counter | Gauge | Histogram>): string {
  const out: string[] = [];
  for (const m of metrics) {
    out.push(`# HELP ${m.name} ${escHelp(m.help)}`);
    out.push(`# TYPE ${m.name} ${m.type}`);
    for (const [key, s] of m.series) {
      const labels = m.labelsOf(key);
      if (m.type !== "histogram") {
        out.push(`${m.name}${renderLabels(labels)} ${formatNumber((s as { value: number }).value)}`);
        continue;
      }
      const h = m as Histogram;
      const series = s as { counts: number[]; sum: number; count: number };
      let cum = 0;
      h.buckets.forEach((le, i) => {
        cum += series.counts[i];
        out.push(`${m.name}_bucket${renderLabels({ ...labels, le: formatNumber(le) })} ${cum}`);
      });
      out.push(`${m.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${series.count}`);
      out.push(`${m.name}_sum${renderLabels(labels)} ${formatNumber(series.sum)}`);
      out.push(`${m.name}_count${renderLabels(labels)} ${series.count}`);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Joins several expositions into one. A family that appears in more than
 * one (the edge's and the core's `mmo_channel_*`, told apart by `side`)
 * keeps its first HELP/TYPE and gathers every sample under it, since a
 * scrape may declare each family only once.
 */
export function mergeExpositions(...texts: string[]): string {
  const families = new Map<string, { meta: string[]; samples: string[] }>();
  for (const text of texts) {
    let current: { meta: string[]; samples: string[] } | null = null;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const m = /^# (HELP|TYPE) (\S+)/.exec(line);
      if (m) {
        let f = families.get(m[2]);
        if (!f) { f = { meta: [], samples: [] }; families.set(m[2], f); }
        if (!f.meta.some((l) => l.startsWith(`# ${m[1]} `))) f.meta.push(line);
        current = f;
        continue;
      }
      if (line.startsWith("#")) continue;
      if (current) current.samples.push(line);
    }
  }
  const out: string[] = [];
  for (const f of families.values()) out.push(...f.meta, ...f.samples);
  return out.length ? out.join("\n") + "\n" : "";
}
