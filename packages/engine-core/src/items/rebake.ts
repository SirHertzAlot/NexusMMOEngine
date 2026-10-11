/**
 * Rebake the loot pool without losing what players hold (roadmap L3).
 *
 * A bake makes a whole new pool, and an item's `def` is its index in the pool,
 * so a plain rebake would turn every held item into some other item. The
 * rebake here keeps them: items in bags and hands (the ledger's Bag and Hold
 * rows) go to the bake as `held`, which keeps them in the new pool, and the
 * ledger then gets a new row for every live item with its def in the new
 * pool (the log stays append-only, so the old rows remain as history).
 * Ground items aren't held: they're short-lived, and a ground item whose
 * pool entry is gone is tombstoned.
 *
 * Run with the server stopped:
 *   node dist/src/items/rebake.js --db data/world.db --pool data/loot/pool.jsonl --size 10000 --seed 2
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeLootPool, type PoolItem } from "@mmo-engine/compose";
import { ItemLedger, LedgerKind, type ItemRow } from "../persist/item-ledger.js";
import { readPoolFile, type PoolItemLike } from "./item-defs.js";

/** The pool entries held in bags, hands and armour slots, each once, in pool order. */
export function heldFromLedger(rows: readonly ItemRow[], pool: readonly PoolItemLike[]): PoolItemLike[] {
  const defs = new Set<number>();
  for (const r of rows) {
    if ((r.kind === LedgerKind.Bag || r.kind === LedgerKind.Hold || r.kind === LedgerKind.Wear) && r.def >= 0 && r.def < pool.length) defs.add(r.def);
  }
  return [...defs].sort((a, b) => a - b).map((d) => pool[d]);
}

/** Old def index to new def index, by pool id; ids missing from the new pool are left out. */
export function defRemap(oldPool: readonly PoolItemLike[], newPool: readonly PoolItemLike[]): Map<number, number> {
  const at = new Map<string, number>();
  newPool.forEach((p, i) => at.set(p.id, i));
  const map = new Map<number, number>();
  oldPool.forEach((p, i) => {
    const j = at.get(p.id);
    if (j !== undefined) map.set(i, j);
  });
  return map;
}

/**
 * Record every live item again with its new def (items whose def has no
 * place in the new pool are destroyed). The caller flushes.
 */
export function remapLedger(
  ledger: ItemLedger,
  rows: readonly ItemRow[],
  map: ReadonlyMap<number, number>,
): { moved: number; destroyed: number } {
  let moved = 0;
  let destroyed = 0;
  for (const r of rows) {
    const def = map.get(r.def);
    if (def === undefined) {
      ledger.record(LedgerKind.Destroy, r.id, r.def, r.owner, r.slot, r.durability, r.x, r.z);
      destroyed++;
    } else {
      ledger.record(r.kind, r.id, def, r.owner, r.slot, r.durability, r.x, r.z);
      moved++;
    }
  }
  return { moved, destroyed };
}

export interface RebakeOptions {
  size: number;
  seed: number;
}

export interface RebakeResult {
  pool: PoolItem[];
  held: number;
  moved: number;
  destroyed: number;
}

/** Bake a new pool that keeps what the ledger says is held, and remap the ledger to it. */
export function rebakeKeepingHeld(ledger: ItemLedger, oldPool: readonly PoolItemLike[], o: RebakeOptions): RebakeResult {
  const rows = ledger.load();
  const held = heldFromLedger(rows, oldPool);
  const baked = bakeLootPool({ size: o.size, seed: o.seed, held: held as unknown as PoolItem[] });
  const { moved, destroyed } = remapLedger(ledger, rows, defRemap(oldPool, baked.items));
  ledger.flush();
  return { pool: baked.items, held: held.length, moved, destroyed };
}

function main(): void {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error("usage: rebake --db <world.db> --pool <pool.jsonl> [--size N] [--seed N]");
    args.set(argv[i].slice(2), argv[i + 1]);
  }
  const db = args.get("db");
  const poolFile = args.get("pool");
  if (!db || !poolFile) throw new Error("--db and --pool are required");
  const oldPool = readPoolFile(poolFile);
  const ledger = new ItemLedger(resolve(db));
  try {
    const r = rebakeKeepingHeld(ledger, oldPool, {
      size: Number(args.get("size") ?? oldPool.length),
      seed: Number(args.get("seed") ?? 1) >>> 0,
    });
    mkdirSync(dirname(resolve(poolFile)), { recursive: true });
    writeFileSync(poolFile, r.pool.map((i) => JSON.stringify(i)).join("\n") + "\n");
    console.log(`[rebake] ${r.pool.length} items, ${r.held} held kept, ${r.moved} ledger items remapped, ${r.destroyed} destroyed -> ${poolFile}`);
  } finally {
    ledger.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
