/**
 * Stat values from bases and modifiers: the arithmetic shared by the
 * server's stat book, the tests and (later) the editor's rules view.
 *
 * A game lists primary attributes and derived stats in stats.json (either
 * list may be empty). Attributes are computed first, then each derived
 * stat adds a share of the attributes' final values to its own base, so
 * a +5 strength buff also raises every stat that reads strength:
 *
 *   attribute = clamp((base + Σ add) × (1 + Σ percent) × Π multiply)
 *   derived   = clamp((base + Σ attribute × perPoint + Σ add) × (1 + Σ percent) × Π multiply)
 *
 * Everything is indexed by a StatLayout (attributes first, in the rules'
 * order), so per-entity values are plain Float64Arrays.
 */

import type { ModifierOp, StatDrive, StatsRules } from "./schemas.js";

/** One change to one stat (from an effect, an item, an injury, …). */
export interface StatModifier {
  stat: string;
  op: ModifierOp;
  value: number;
}

/** Where every stat sits in a values array, and the rules that shape it. */
export class StatLayout {
  /** Every stat id: attributes first, then derived stats, in the rules' order. */
  readonly ids: readonly string[];
  readonly names: readonly string[];
  /** Stats [0, attributeCount) are attributes; the rest are derived. */
  readonly attributeCount: number;
  readonly index: ReadonlyMap<string, number>;
  /** Each stat's base in the rules (a new entity's starting values). */
  readonly bases: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  /** Per stat: the attributes it reads, as [attribute index, amount per point]. */
  readonly from: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Engine drive -> the stat bound to it. */
  readonly drives: ReadonlyMap<StatDrive, number>;

  constructor(rules: StatsRules) {
    const all = [...rules.attributes, ...rules.stats];
    this.ids = all.map((s) => s.id);
    this.names = all.map((s) => s.name);
    this.attributeCount = rules.attributes.length;
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.bases = Float64Array.from(all, (s) => s.base);
    this.min = Float64Array.from(all, (s) => s.min ?? -Infinity);
    this.max = Float64Array.from(all, (s) => s.max ?? Infinity);
    this.from = [
      ...rules.attributes.map(() => []),
      ...rules.stats.map((s) => Object.entries(s.from).map(([attr, k]) => [this.index.get(attr)!, k] as const)),
    ];
    const drives = new Map<StatDrive, number>();
    all.forEach((s, i) => s.drives !== undefined && drives.set(s.drives, i));
    this.drives = drives;
  }

  get size(): number {
    return this.ids.length;
  }
}

/** Modifier totals per stat, gathered before computing. */
export class ModifierTotals {
  readonly add: Float64Array;
  readonly percent: Float64Array;
  readonly multiply: Float64Array;

  constructor(size: number) {
    this.add = new Float64Array(size);
    this.percent = new Float64Array(size);
    this.multiply = new Float64Array(size).fill(1);
  }

  reset(): void {
    this.add.fill(0);
    this.percent.fill(0);
    this.multiply.fill(1);
  }

  apply(index: number, op: ModifierOp, value: number): void {
    if (op === "add") this.add[index] += value;
    else if (op === "percent") this.percent[index] += value;
    else this.multiply[index] *= value;
  }
}

/**
 * Every stat's value into `out`: from per-stat `bases` (start from
 * layout.bases) and the modifier totals (null: unmodified, what a
 * character sheet shows as the base).
 */
export function computeStats(
  layout: StatLayout,
  bases: ArrayLike<number>,
  totals: ModifierTotals | null,
  out: Float64Array = new Float64Array(layout.size),
): Float64Array {
  for (let i = 0; i < layout.size; i++) {
    let v = bases[i];
    // Attributes come first, so their final values are ready here.
    for (const [a, k] of layout.from[i]) v += out[a] * k;
    if (totals) v = (v + totals.add[i]) * (1 + totals.percent[i]) * totals.multiply[i];
    out[i] = Math.min(layout.max[i], Math.max(layout.min[i], v));
  }
  return out;
}
