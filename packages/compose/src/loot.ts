/**
 * The loot pool: a large set of composed items, baked once and balanced by
 * rank, that every drop draws from, so the economy's supply is known and
 * tunable.
 *
 * - Exact shares: each rank gets exactly its ladder share of the pool
 *   (largest remainder, so the counts sum to the size): 10,000 items at
 *   legendary 10% hold exactly 1,000 legendaries.
 * - Sources: every item belongs to a source (mob drops, chests, bosses,
 *   crafting). Each source has an affinity for each rank; a rank's items
 *   are split across sources by it, again exactly. Low ranks come mostly
 *   from mobs, high ranks from bosses.
 * - Uniqueness: a top-rank item is a one-of-a-kind composition (its name
 *   and parts are its own): the bake retries seeds until each is new.
 * - Held items survive: a rebake keeps the items players already hold (the
 *   world server's record) and fills around them, still hitting the exact
 *   counts.
 * - A balance report: counts by rank and source, a rank × source × material
 *   table, and the expected play time to obtain each rank from each source
 *   (from each source's drops per hour).
 */

import { deriveSeed } from "@mmo-engine/wfc";
import { BUILTIN_CATALOG, type Catalog } from "./catalog.js";
import { composeItem, type EntityBundle } from "./compose.js";
import { DEFAULT_LADDER, type Ladder } from "./ranks.js";

export interface LootSource {
  id: string;
  /** Affinity for a rank by its place on the ladder (0 lowest … 1 top): higher takes more of that rank. */
  affinity: (t: number) => number;
  /** How many items a player gets from this source in an hour of play (for the report). */
  dropsPerHour: number;
}

export const DEFAULT_SOURCES: LootSource[] = [
  { id: "mob", affinity: (t) => 3 * (1 - t) + 0.1, dropsPerHour: 120 },
  { id: "chest", affinity: () => 1, dropsPerHour: 12 },
  { id: "boss", affinity: (t) => 3 * t + 0.05, dropsPerHour: 2 },
  { id: "craft", affinity: (t) => 0.6 * (1 - Math.abs(t - 0.5)), dropsPerHour: 4 },
];

export interface PoolItem {
  id: string;
  rank: string;
  source: string;
  item: string;
  seed: number;
  bundle: EntityBundle;
}

export interface LootPoolOptions {
  size: number;
  seed?: number;
  ladder?: Ladder;
  catalog?: Catalog;
  sources?: LootSource[];
  /** Items already in players' hands: kept as they are, and counted toward the quotas. */
  held?: readonly PoolItem[];
  /** Item types to draw from (default: every catalog item), with weights (default 1). */
  itemWeights?: Record<string, number>;
}

export interface LootReport {
  size: number;
  byRank: Record<string, { count: number; share: number; target: number }>;
  bySource: Record<string, Record<string, number>>;
  /** rank → source → material → count. */
  materials: Record<string, Record<string, Record<string, number>>>;
  /** rank → source → expected hours of play to get one (null: that source never gives it). */
  hoursToObtain: Record<string, Record<string, number | null>>;
  /** Fewest hours to one of each rank, over all sources. */
  fastestHours: Record<string, number | null>;
  kept: number;
  retries: number;
}

export interface LootPool {
  items: PoolItem[];
  report: LootReport;
}

/** Split `total` in proportion to `weights`, as whole numbers summing to `total` (largest remainder). */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

export function bakeLootPool(o: LootPoolOptions): LootPool {
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const sources = o.sources ?? DEFAULT_SOURCES;
  const baseSeed = o.seed ?? 1;
  const n = ladder.ranks.length;
  if (!Number.isInteger(o.size) || o.size < 1) throw new Error(`pool size must be a positive whole number (got ${o.size})`);

  // Exact counts per rank, then per source within each rank.
  const rankCounts = apportion(o.size, ladder.ranks.map((r) => r.share));
  const quota = new Map<string, number>(); // `${rank}|${source}` → items still to make
  ladder.ranks.forEach((r, k) => {
    const t = n > 1 ? k / (n - 1) : 0;
    const split = apportion(rankCounts[k], sources.map((s) => Math.max(0, s.affinity(t))));
    sources.forEach((s, j) => quota.set(`${r.id}|${s.id}`, split[j]));
  });

  const items: PoolItem[] = [];
  const topRank = ladder.ranks[n - 1].id;
  const seenTop = new Set<string>();
  // Held items first: they keep their slot in the quotas.
  for (const h of o.held ?? []) {
    const key = `${h.rank}|${h.source}`;
    const left = quota.get(key);
    if (left === undefined) throw new Error(`held item ${h.id}: rank "${h.rank}" or source "${h.source}" isn't in this pool`);
    if (left <= 0) throw new Error(`held item ${h.id}: more held ${h.rank} items from ${h.source} than the pool has room for (raise the size)`);
    quota.set(key, left - 1);
    if (h.rank === topRank) seenTop.add(h.id);
    items.push(h);
  }

  const types = Object.keys(catalog.items);
  const weights = types.map((t) => o.itemWeights?.[t] ?? 1);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pickType = (seed: number): string => {
    let x = (deriveSeed(seed, 0x54595045) / 4294967296) * wsum;
    for (let i = 0; i < types.length; i++) if ((x -= weights[i]) < 0) return types[i];
    return types[types.length - 1];
  };

  let retries = 0;
  let serial = 0;
  for (const r of ladder.ranks) {
    for (const s of sources) {
      const key = `${r.id}|${s.id}`;
      for (let left = quota.get(key)!; left > 0; left--) {
        for (let attempt = 0; ; attempt++) {
          const seed = deriveSeed(baseSeed, serial++);
          const item = pickType(seed);
          const c = composeItem(item, r.id, { ladder, catalog, seed });
          const id = c.bundle.Identity.id;
          if (r.id === topRank) {
            if (seenTop.has(id)) {
              retries++;
              if (attempt > 1000) throw new Error(`couldn't find a new ${r.id} composition after 1000 tries (the catalog is too small for this pool)`);
              continue;
            }
            seenTop.add(id);
          }
          items.push({ id, rank: r.id, source: s.id, item, seed, bundle: c.bundle });
          break;
        }
      }
    }
  }

  return { items, report: report(items, ladder, sources, rankCounts, (o.held ?? []).length, retries) };
}

function report(items: PoolItem[], ladder: Ladder, sources: LootSource[], targets: number[], kept: number, retries: number): LootReport {
  const byRank: LootReport["byRank"] = {};
  const bySource: LootReport["bySource"] = {};
  const materials: LootReport["materials"] = {};
  ladder.ranks.forEach((r, k) => {
    byRank[r.id] = { count: 0, share: 0, target: targets[k] };
    bySource[r.id] = Object.fromEntries(sources.map((s) => [s.id, 0]));
    materials[r.id] = Object.fromEntries(sources.map((s) => [s.id, {}]));
  });
  const perSource = new Map<string, number>(sources.map((s) => [s.id, 0]));
  for (const it of items) {
    byRank[it.rank].count++;
    bySource[it.rank][it.source]++;
    perSource.set(it.source, (perSource.get(it.source) ?? 0) + 1);
    const mat = it.bundle.Material ?? "none";
    const m = materials[it.rank][it.source];
    m[mat] = (m[mat] ?? 0) + 1;
  }
  for (const r of Object.values(byRank)) r.share = Math.round((r.count / items.length) * 10000) / 100;
  // A drop from a source is one of its items at random: one of rank r takes (items / items of r) drops.
  const hoursToObtain: LootReport["hoursToObtain"] = {};
  const fastestHours: LootReport["fastestHours"] = {};
  for (const r of ladder.ranks) {
    hoursToObtain[r.id] = {};
    let best: number | null = null;
    for (const s of sources) {
      const have = bySource[r.id][s.id];
      const h = have > 0 ? Math.round(((perSource.get(s.id)! / have) / s.dropsPerHour) * 100) / 100 : null;
      hoursToObtain[r.id][s.id] = h;
      if (h !== null && (best === null || h < best)) best = h;
    }
    fastestHours[r.id] = best;
  }
  return { size: items.length, byRank, bySource, materials, hoursToObtain, fastestHours, kept, retries };
}

/** The report as a readable Markdown table (for the bake's output folder). */
export function reportMarkdown(r: LootReport, ladder: Ladder = DEFAULT_LADDER): string {
  const sources = Object.keys(Object.values(r.bySource)[0] ?? {});
  const lines = [
    `# Loot pool: ${r.size} items`,
    "",
    `Held items kept: ${r.kept}. Seeds retried for unique top-rank items: ${r.retries}.`,
    "",
    "| Rank | Items | Share | Target | " + sources.map((s) => `from ${s}`).join(" | ") + " | Fastest (h) |",
    "|---|---|---|---|" + sources.map(() => "---|").join("") + "---|",
  ];
  for (const rank of ladder.ranks) {
    const b = r.byRank[rank.id];
    if (!b) continue;
    lines.push(`| ${rank.name} | ${b.count} | ${b.share}% | ${b.target} | ${sources.map((s) => r.bySource[rank.id][s]).join(" | ")} | ${r.fastestHours[rank.id] ?? "—"} |`);
  }
  lines.push("", "## Hours of play to obtain one, by source", "", "| Rank | " + sources.join(" | ") + " |", "|---|" + sources.map(() => "---|").join(""));
  for (const rank of ladder.ranks) lines.push(`| ${rank.name} | ${sources.map((s) => r.hoursToObtain[rank.id]?.[s] ?? "—").join(" | ")} |`);
  lines.push("", "## Materials by rank (all sources)", "");
  for (const rank of ladder.ranks) {
    const total: Record<string, number> = {};
    for (const m of Object.values(r.materials[rank.id] ?? {})) for (const [k, v] of Object.entries(m)) total[k] = (total[k] ?? 0) + v;
    const top = Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    lines.push(`- **${rank.name}:** ${top}`);
  }
  return lines.join("\n") + "\n";
}
