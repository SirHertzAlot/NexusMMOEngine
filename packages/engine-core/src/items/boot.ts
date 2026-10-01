/**
 * Item definitions at boot: the baked loot pool when there is one
 * (`npm run loot:bake` writes <data>/loot/pool.jsonl), else a small pool
 * baked in-process with the same seed, so a fresh checkout still has
 * items to drop (about a second for 600 items).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { bakeLootPool } from "@mmo-engine/compose";
import type { Rules } from "@mmo-engine/rules";
import { ItemDefs, readPoolFile, type PoolItemLike } from "./item-defs.js";

export interface LoadedItems {
  defs: ItemDefs;
  /** Where the definitions came from, for the boot log. */
  summary: string;
}

/** Items baked in-process when there's no pool file. */
export const FALLBACK_POOL_SIZE = 600;

export function loadItemDefs(dataDir: string, rules: Pick<Rules, "items">, fallbackSize = FALLBACK_POOL_SIZE): LoadedItems {
  const file = path.join(dataDir, "loot", "pool.jsonl");
  if (existsSync(file)) {
    const items = readPoolFile(file);
    return { defs: new ItemDefs(items, rules), summary: `items: ${items.length} from ${file}` };
  }
  const pool = bakeLootPool({ size: fallbackSize, seed: 1 });
  return {
    defs: new ItemDefs(pool.items as PoolItemLike[], rules),
    summary: `items: ${pool.items.length} baked at boot (no ${file}; run npm run loot:bake for the full pool)`,
  };
}
