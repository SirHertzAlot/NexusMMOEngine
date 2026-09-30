/**
 * Composing an entity (a creature or an item) at a rank, by WFC over its
 * component tree:
 *
 *   base ─┬─ material                 (items)
 *         ├─ affix × 0 … 4            (by the rank's place on the ladder)
 *         ├─ ability × …              (creatures 1, 2 from three quarters up; items 1 from halfway)
 *         ├─ unique ability           (the top rank)
 *         └─ aura, runes, particles, tint, transform   (as the rank's signals say)
 *
 * Every slot takes one component that fits the base, the entity kind and
 * the rank. Across the tree:
 *
 *  - no component twice
 *  - nothing a component excludes (fire and frost, holy on a demon)
 *  - one element at most: a hidden affinity slot (an element, or none)
 *    that every elemental part must match; an elemental base limits it
 *    to its own elements (a fire demon's parts are fire, if anything)
 *  - elemental signals only for an element the entity has
 *  - the total cost within the rank's budget, and above the rank below's,
 *    so each rank is stronger than the last
 *  - materials outside the budget: their cost is their grade, capped by
 *    rank (common up to 1 … legendary up to 5), so top-rank gear can reach
 *    the top materials (before, the mandatory slots left it no room)
 *
 * WFC collapses the lowest-entropy slot first, weighted by the components'
 * weights and any bias (a molten dungeon favours fire). The same inputs
 * and seed always give the same entity.
 *
 * The result is an ECS bundle: identity, rank, stats, affixes, abilities,
 * signals, and the prefab the client builds its Object3D from.
 */

import { deriveSeed, mulberry32, solve, WfcError, type WfcNeed, type WfcOption, type WfcProblem } from "@mmo-engine/wfc";
import { BUILTIN_CATALOG, ELEMENTS, elementOf, SIGNAL_SLOTS, type Catalog, type Component, type CreatureBase, type EntityKind, type SlotKind } from "./catalog.js";
import { DEFAULT_LADDER, rankOf, type Ladder } from "./ranks.js";

export interface ComposeOptions {
  ladder?: Ladder;
  catalog?: Catalog;
  /** Weight multipliers by tag (a molten dungeon: `{ fire: 3 }`). */
  bias?: Record<string, number>;
  seed?: number;
}

export interface Part {
  slot: SlotKind;
  id: string;
}

export interface PrefabAttachment {
  kind: "aura" | "runes" | "particles" | "tint" | "transform";
  id: string;
  params: Record<string, number | string | boolean>;
}

/** The entity as ECS components. */
export interface EntityBundle {
  Identity: { id: string; name: string; kind: EntityKind; base: string };
  Rank: { id: string; index: number; color: string };
  /** The entity's element (null: none). */
  Element: string | null;
  Stats: Record<string, number>;
  Material: string | null;
  Affixes: string[];
  Abilities: string[];
  Signals: Partial<Record<PrefabAttachment["kind"], string>>;
  /** For the client: the base mesh or species, and what to attach to it. */
  Prefab: { base: string; color: string | null; attach: PrefabAttachment[] };
}

export interface Composition {
  bundle: EntityBundle;
  parts: Part[];
  /** Budget spent. */
  cost: number;
  /** Every tag on the entity (its base's and its parts'). */
  tags: string[];
  /** Rules loosened because the catalog couldn't meet them for this base and rank. */
  relaxed: string[];
}

interface Base {
  id: string;
  name: string;
  tags: readonly string[];
  stats: Record<string, number>;
  prefab: string;
}

/** An item of type `itemId` (a catalog item) at a rank. */
export function composeItem(itemId: string, rankId: string, o: ComposeOptions = {}): Composition {
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const item = catalog.items[itemId];
  if (!item) throw new Error(`no item "${itemId}" (have: ${Object.keys(catalog.items).join(", ")})`);
  return compose("item", { id: itemId, name: item.name, tags: item.tags, stats: item.stats, prefab: item.prefab }, rankId, o);
}

/** A creature (a species, or any base) at a rank. */
export function composeCreature(base: CreatureBase, rankId: string, o: ComposeOptions = {}): Composition {
  return compose("creature", { id: base.id, name: base.name, tags: base.tags, stats: base.stats ?? {}, prefab: base.prefab ?? base.id }, rankId, o);
}

function compose(kind: EntityKind, base: Base, rankId: string, o: ComposeOptions): Composition {
  const ladder = o.ladder ?? DEFAULT_LADDER;
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const { rank, index } = rankOf(ladder, rankId);
  const seed = o.seed ?? 1;
  const baseTags = new Set([...base.tags, kind]);

  // Options: the base (index 0), then every component this kind can take.
  const ids = Object.keys(catalog.components).filter((cid) => catalog.components[cid].for.includes(kind));
  const comps: Component[] = ids.map((cid) => catalog.components[cid]);
  const options: WfcOption[] = [{ id: `base:${base.id}`, tags: [...baseTags] }, ...ids.map((cid, i) => ({ id: cid, tags: comps[i].tags }))];
  // Then the affinity options: each element, and none.
  const K = options.length;
  const affinities = [...ELEMENTS, null];
  for (const e of affinities) options.push({ id: `affinity:${e ?? "none"}`, tags: e ? [e] : [] });
  const isAffinity = (k: number): boolean => k >= K;
  const affinityOf = (k: number): string | null => affinities[k - K];
  const tagsOf = (k: number): readonly string[] => options[k].tags ?? [];
  const excludesOf = (k: number): readonly string[] => (k === 0 || isAffinity(k) ? [] : comps[k - 1].excludes);
  const elementsOf = (k: number): string[] => tagsOf(k).filter((t) => (ELEMENTS as readonly string[]).includes(t));
  const clash = (x: number, y: number): boolean => {
    if (isAffinity(y)) [x, y] = [y, x];
    if (isAffinity(x)) {
      if (isAffinity(y)) return false;
      const a = affinityOf(x), es = elementsOf(y);
      // The base may carry elements the entity's parts don't use; a part's element is the affinity.
      return y === 0 ? a !== null && es.length > 0 && !es.includes(a) : es.length > 0 && !es.includes(a ?? "");
    }
    return excludesOf(x).some((t) => tagsOf(y).includes(t)) || excludesOf(y).some((t) => tagsOf(x).includes(t));
  };

  const allowed = (k: number, slot: SlotKind): boolean => {
    const comp = comps[k - 1];
    // Materials sit outside the power budget; their cost is their grade, which the rank caps (common: up to 1).
    const graded = slot !== "material" || comp.cost <= index + 1;
    return comp.slot === slot && graded && index >= comp.minRank && (comp.fits.length === 0 || comp.fits.some((t) => baseTags.has(t))) && !clash(0, k);
  };
  const domainOf = (slot: SlotKind): number[] => {
    const d: number[] = [];
    for (let k = 1; k < K; k++) if (allowed(k, slot)) d.push(k);
    return d;
  };

  // The tree's slots for this kind and rank.
  const s = rank.signals;
  // Where the rank sits on the ladder: 0 the lowest, 1 the highest.
  const t = ladder.ranks.length > 1 ? index / (ladder.ranks.length - 1) : 0;
  const want: [SlotKind, number][] = [
    ["material", kind === "item" ? 1 : 0],
    ["affix", Math.round(4 * t)],
    ["ability", kind === "creature" ? (t >= 0.75 ? 2 : 1) : t >= 0.5 ? 1 : 0],
    ["unique", s.uniqueAbility ? 1 : 0],
    ["aura", s.aura ? 1 : 0],
    ["runes", s.runes ? 1 : 0],
    ["particles", s.particles ? 1 : 0],
    ["tint", s.tint ? 1 : 0],
    ["transform", s.transforms ? 1 : 0],
  ];
  const slots: SlotKind[] = [];
  const domains: number[][] = [[0]];
  for (const [slot, n] of want) {
    const d = domainOf(slot);
    // A catalog with fewer choices than slots (no two affixes the same) gets fewer slots.
    for (let i = 0; i < Math.min(n, d.length); i++) {
      slots.push(slot);
      domains.push(d);
    }
  }
  // A catalog too dear for the budget loses its last affixes, then abilities, until the cheapest choices fit.
  const cheapest = (d: number[]): number => Math.min(...d.map((k) => (k === 0 ? 0 : comps[k - 1].cost)));
  for (const drop of ["affix", "ability", "unique"] as const) {
    while (domains.reduce((t2, d) => t2 + cheapest(d), 0) > rank.budget) {
      const i = slots.lastIndexOf(drop);
      if (i < 0) break;
      slots.splice(i, 1);
      domains.splice(i + 1, 1);
    }
  }
  // The affinity slot: elements some part could carry here (and none).
  const affinityDomain: number[] = [];
  for (let k = K; k < options.length; k++) {
    const a = affinityOf(k);
    if (clash(0, k)) continue;
    if (a === null || domains.slice(1).some((d) => d.some((j) => elementsOf(j).includes(a) && !SIGNAL_SLOTS.includes(comps[j - 1].slot)))) affinityDomain.push(k);
  }
  domains.push(affinityDomain);
  const N = slots.length + 2;

  // Weights: the component's, times the bias for its tags.
  const bias = o.bias ?? {};
  // Higher ranks lean to dearer parts (mithril over iron), as well as spending more.
  const weight = (k: number): number =>
    (k === 0 || isAffinity(k) ? 1 : comps[k - 1].weight * (1 + comps[k - 1].cost * t)) * tagsOf(k).reduce((w, tag) => w * (bias[tag] ?? 1), 1);
  const options2 = options.map((opt, k) => ({ ...opt, weight: weight(k) }));

  // Elemental signals need their element on the entity (the base, or a part that isn't a signal).
  const needs: WfcNeed[] = [];
  for (let k = 1; k < K; k++) {
    const comp = comps[k - 1];
    const e = elementOf(comp);
    if (!e || !SIGNAL_SLOTS.includes(comp.slot)) continue;
    const from: number[] = [];
    for (let j = 0; j < K; j++) if (tagsOf(j).includes(e) && (j === 0 || !SIGNAL_SLOTS.includes(comps[j - 1].slot))) from.push(j);
    needs.push({ option: k, from });
  }

  // Every slot is every other's neighbour: the tree is small, and the rules are about the whole entity.
  const edges: { a: number; b: number; rule: string }[] = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) edges.push({ a, b, rule: "coherent" });

  const cost = options.map((_, k) => (k === 0 || isAffinity(k) || comps[k - 1].slot === "material" ? 0 : comps[k - 1].cost));
  const reach = domains.reduce((t, d) => t + Math.max(...d.map((k) => cost[k])), 0);
  const floor = index > 0 ? Math.min(ladder.ranks[index - 1].budget + 1, reach, rank.budget) : 0;

  const problem = (minSpend: number): WfcProblem => ({
    options: options2,
    slots: N,
    domains,
    edges,
    rules: { coherent: (_x, _y, xi, yi) => xi !== yi && !clash(xi, yi) },
    needs,
    budgets: [{ cost, max: rank.budget, min: minSpend }],
    pins: { 0: 0 },
  });
  const relaxed: string[] = [];
  const wseed = deriveSeed(seed, 0x434f4d50);
  let assignment: Int32Array;
  try {
    assignment = solve(problem(floor), { seed: wseed }).assignment;
  } catch (e) {
    if (!(e instanceof WfcError)) throw e;
    relaxed.push("budget floor");
    assignment = solve(problem(0), { seed: wseed }).assignment;
  }

  const parts: Part[] = slots.map((slot, i) => ({ slot, id: options[assignment[i + 1]].id }));
  // The affinity counts once something carries it.
  const chosen = affinityOf(assignment[N - 1]);
  const element = chosen && (baseTags.has(chosen) || parts.some((p) => catalog.components[p.id].tags.includes(chosen))) ? chosen : null;
  const partComps = parts.map((p) => catalog.components[p.id]);
  const spent = partComps.reduce((t, comp) => t + (comp.slot === "material" ? 0 : comp.cost), 0);

  // Stats: the base's, scaled by rank, plus every part's.
  const stats: Record<string, number> = {};
  const scale = 1 + 0.2 * index;
  for (const [k, v] of Object.entries(base.stats)) stats[k] = Math.round(v * scale * 100) / 100;
  for (const comp of partComps) for (const [k, v] of Object.entries(comp.stats)) stats[k] = Math.round(((stats[k] ?? 0) + v) * 100) / 100;

  const of = (slot: SlotKind): string[] => parts.filter((p) => p.slot === slot).map((p) => p.id);
  const material = of("material")[0] ?? null;
  const attach: PrefabAttachment[] = parts
    .filter((p) => SIGNAL_SLOTS.includes(p.slot))
    .map((p) => {
      const params = { ...catalog.components[p.id].params };
      // The rank's own tint takes the rank's colour.
      if (p.slot === "tint" && params.color === undefined) params.color = rank.color;
      return { kind: p.slot as PrefabAttachment["kind"], id: p.id, params };
    });
  const tags = [...new Set([...baseTags, ...partComps.flatMap((comp) => comp.tags)])].sort();
  const id = hash64(JSON.stringify([kind, base.id, rank.id, parts]));
  // The proper name follows the composition, so two different legendaries aren't namesakes.
  const name = nameOf(kind, base, parts, catalog, index === ladder.ranks.length - 1 && ladder.ranks.length > 1, parseInt(id.slice(0, 8), 16));

  return {
    bundle: {
      Identity: { id, name, kind, base: base.id },
      Rank: { id: rank.id, index, color: rank.color },
      Element: element,
      Stats: stats,
      Material: material,
      Affixes: of("affix"),
      Abilities: [...of("ability"), ...of("unique")],
      Signals: Object.fromEntries(attach.map((a) => [a.kind, a.id])),
      Prefab: { base: base.prefab, color: material ? String(catalog.components[material].params.color ?? "") || null : null, attach },
    },
    parts,
    cost: spent,
    tags,
    relaxed,
  };
}

/** 64-bit FNV-1a as 16 hex digits (no node:crypto: this runs in browsers too). */
function hash64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

const SYLLABLES = ["ae", "bel", "cor", "dra", "el", "fen", "gor", "hal", "ith", "kar", "lor", "mor", "nae", "or", "quel", "ra", "sil", "thar", "ul", "vor", "wyn", "xan", "yr", "zeth"];

const title = (id: string): string => id.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** "Flaming Mithril Sword of the Bear"; the top rank also gets a proper name ("Korvath, …"). */
function nameOf(kind: EntityKind, base: Base, parts: Part[], catalog: Catalog, top: boolean, seed: number): string {
  const affixes = parts.filter((p) => p.slot === "affix").map((p) => catalog.components[p.id]);
  const prefix = affixes.find((a) => a.prefix)?.prefix;
  const suffix = affixes.find((a) => a.suffix)?.suffix;
  const mat = parts.find((p) => p.slot === "material");
  const words = [prefix, mat ? (catalog.components[mat.id].name ?? title(mat.id)) : undefined, base.name, suffix].filter(Boolean);
  const plain = words.join(" ");
  if (!top) return plain;
  const r = mulberry32(deriveSeed(seed, 0x4e414d45));
  const n = 2 + Math.floor(r() * 2);
  let proper = "";
  for (let i = 0; i < n; i++) proper += SYLLABLES[Math.floor(r() * SYLLABLES.length)];
  proper = proper[0].toUpperCase() + proper.slice(1);
  return kind === "creature" ? `${proper} the ${plain}` : `${proper}, ${plain}`;
}
