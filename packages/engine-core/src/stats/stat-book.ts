/**
 * StatBook — every entity's stats on the server: its bases (the rules',
 * or its own, like a troll's), the modifiers on it, and the values they
 * make. Values are recomputed only after something changes, so systems
 * can read them every tick for the cost of a lookup.
 *
 * Stats are server state, not an ECS component: the stat list is data
 * (content/rules/stats.json), so it has no fixed SoA layout. An owner is
 * sent their own stats in the `stats` message (catalog §0x0f).
 *
 * Entity slots are reused, so SimWorld.despawn detaches an entity's stats:
 * a new entity in the same slot never inherits them.
 */

import {
  computeStats,
  ModifierTotals,
  StatLayout,
  type ModifierOp,
  type StatDrive,
  type StatsRules,
} from "@mmo-engine/rules";

/** A modifier to put on an entity; `source` names what it came from (an effect, an item). */
export interface ModifierSpec {
  stat: string;
  op: ModifierOp;
  value: number;
  source: string;
}

/** One line of a character sheet. */
export interface StatLine {
  id: string;
  name: string;
  /** With every modifier. */
  value: number;
  /** Without any modifier (the entity's bases alone). */
  base: number;
  attribute: boolean;
}

interface Modifier {
  handle: number;
  index: number;
  op: ModifierOp;
  value: number;
  source: string;
}

interface Sheet {
  bases: Float64Array;
  values: Float64Array;
  mods: Modifier[];
  dirty: boolean;
  version: number;
}

const NO_STATS: StatsRules = { attributes: [], stats: [] };

export class StatBook {
  readonly layout: StatLayout;
  private readonly sheets = new Map<number, Sheet>();
  private readonly totals: ModifierTotals;
  private nextHandle = 1;
  /**
   * Versions come from one counter for the whole book, so a version is
   * never seen twice, even on a new entity in a reused slot.
   */
  private clock = 0;

  constructor(rules: StatsRules = NO_STATS) {
    this.layout = new StatLayout(rules);
    this.totals = new ModifierTotals(this.layout.size);
  }

  /** The rules define no stats: every drive keeps the engine's built-in behaviour. */
  get empty(): boolean {
    return this.layout.size === 0;
  }

  has(eid: number): boolean {
    return this.sheets.has(eid);
  }

  /**
   * Give an entity stats: the rules' bases, with `bases` overriding them by
   * id. Replaces whatever stats (and modifiers) it had.
   */
  attach(eid: number, bases: Readonly<Record<string, number>> = {}): void {
    const sheet: Sheet = {
      bases: Float64Array.from(this.layout.bases),
      values: new Float64Array(this.layout.size),
      mods: [],
      dirty: true,
      version: ++this.clock,
    };
    for (const [id, v] of Object.entries(bases)) sheet.bases[this.indexOf(id)] = v;
    this.sheets.set(eid, sheet);
  }

  detach(eid: number): void {
    this.sheets.delete(eid);
  }

  /** The stat's value, with modifiers (undefined: no stats on the entity). */
  get(eid: number, id: string): number | undefined {
    const sheet = this.sheets.get(eid);
    return sheet && this.values(sheet)[this.indexOf(id)];
  }

  /**
   * The value of the stat bound to an engine drive; undefined when the
   * rules bind no stat to it or the entity has no stats (the engine then
   * keeps its built-in behaviour).
   */
  drive(eid: number, drive: StatDrive): number | undefined {
    const i = this.layout.drives.get(drive);
    if (i === undefined) return undefined;
    const sheet = this.sheets.get(eid);
    return sheet && this.values(sheet)[i];
  }

  base(eid: number, id: string): number | undefined {
    return this.sheets.get(eid)?.bases[this.indexOf(id)];
  }

  setBase(eid: number, id: string, value: number): void {
    const sheet = this.sheetOf(eid);
    sheet.bases[this.indexOf(id)] = value;
    this.touch(sheet);
  }

  /** Put a modifier on an entity; returns a handle to take it off again. */
  addModifier(eid: number, spec: ModifierSpec): number {
    if (!Number.isFinite(spec.value)) throw new RangeError(`stats: modifier on "${spec.stat}" is not finite (${spec.value})`);
    const sheet = this.sheetOf(eid);
    const handle = this.nextHandle++;
    sheet.mods.push({ handle, index: this.indexOf(spec.stat), op: spec.op, value: spec.value, source: spec.source });
    this.touch(sheet);
    return handle;
  }

  /** Take one modifier off. Returns whether it was there. */
  removeModifier(eid: number, handle: number): boolean {
    const sheet = this.sheets.get(eid);
    const at = sheet?.mods.findIndex((m) => m.handle === handle) ?? -1;
    if (!sheet || at < 0) return false;
    sheet.mods.splice(at, 1);
    this.touch(sheet);
    return true;
  }

  /** Take off every modifier from one source. Returns how many there were. */
  removeSource(eid: number, source: string): number {
    const sheet = this.sheets.get(eid);
    if (!sheet) return 0;
    const before = sheet.mods.length;
    sheet.mods = sheet.mods.filter((m) => m.source !== source);
    const removed = before - sheet.mods.length;
    if (removed > 0) this.touch(sheet);
    return removed;
  }

  /**
   * Changes whenever the entity's values may have (for anything that sends
   * or syncs them); unique across the book. 0: the entity has no stats.
   */
  version(eid: number): number {
    return this.sheets.get(eid)?.version ?? 0;
  }

  /** Every stat with its value and unmodified base: a character sheet. */
  sheet(eid: number): StatLine[] | undefined {
    const sheet = this.sheets.get(eid);
    if (!sheet) return undefined;
    const values = this.values(sheet);
    const bases = computeStats(this.layout, sheet.bases, null);
    return this.layout.ids.map((id, i) => ({
      id,
      name: this.layout.names[i],
      value: values[i],
      base: bases[i],
      attribute: i < this.layout.attributeCount,
    }));
  }

  private values(sheet: Sheet): Float64Array {
    if (sheet.dirty) {
      this.totals.reset();
      for (const m of sheet.mods) this.totals.apply(m.index, m.op, m.value);
      computeStats(this.layout, sheet.bases, this.totals, sheet.values);
      sheet.dirty = false;
    }
    return sheet.values;
  }

  private touch(sheet: Sheet): void {
    sheet.dirty = true;
    sheet.version = ++this.clock;
  }

  private sheetOf(eid: number): Sheet {
    const sheet = this.sheets.get(eid);
    if (!sheet) throw new Error(`stats: entity ${eid} has no stats`);
    return sheet;
  }

  private indexOf(id: string): number {
    const i = this.layout.index.get(id);
    if (i === undefined) throw new Error(`stats: no stat "${id}" in the rules`);
    return i;
  }
}
