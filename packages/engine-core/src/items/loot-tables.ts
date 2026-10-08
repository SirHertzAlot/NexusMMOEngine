/**
 * Loot tables (content/rules/loot.json `tables`): a creature's
 * `drops.table` names lines of "this item base, this often, this many".
 * Pure: the dropper supplies the random numbers and puts the items down.
 */

import type { LootRules } from "@mmo-engine/rules";
import type { ItemDefs } from "./item-defs.js";

export type LootTables = NonNullable<LootRules["tables"]>;

/** The definition a line drops: the base at the named rank, else its lowest rank. -1 when the pool has none. */
export function lineDef(defs: ItemDefs, line: { base: string; rank?: string }, rankOrder: readonly string[]): number {
  if (line.rank === undefined) return defs.starter(line.base, rankOrder);
  return defs.ofBase(line.base).find((i) => defs.ranks[i] === line.rank) ?? -1;
}

/** Roll every line of `table`; returns the definitions to drop (a line's count repeats it). Unknown table or items the pool lacks drop nothing. */
export function rollTable(tables: LootTables, table: string, defs: ItemDefs, rankOrder: readonly string[], rand: () => number): number[] {
  const out: number[] = [];
  for (const line of tables[table]?.entries ?? []) {
    if (rand() >= line.chance) continue;
    const def = lineDef(defs, line, rankOrder);
    if (def < 0) continue;
    const [lo, hi] = line.count;
    const n = lo + Math.floor(rand() * (Math.max(hi, lo) - lo + 1));
    for (let i = 0; i < n; i++) out.push(def);
  }
  return out;
}
