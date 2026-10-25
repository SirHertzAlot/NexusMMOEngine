/**
 * Item admin commands (roadmap A5, first slice) and the item action
 * schema (protocol 0x13). The gateway parses with these and calls the
 * ItemService; nothing here touches sessions.
 *
 *   items {base?, rank?, source?}   how many definitions match, and a sample
 *   give {def? | base?, rank?}      a new item into the caller's bag
 *   drop {def? | base?, rank?}      a new item on the ground at the caller
 *   loot {count?}                   `count` mob drops scattered round the caller
 *
 * The `items` command also carries the bag verbs the ItemService
 * already owns (viewport authoring), as sub-actions in the vendor
 * command's style — they act on the CONSOLE HOLDER's bag, like give:
 *
 *   items {sub: "take", item}       destroy that item in the caller's bag
 *   items {sub: "take", base}       destroy one item of that base instead
 *   items {sub: "move", item, to, from?}  move an item between bags
 *                                   (from defaults to the caller's holder;
 *                                   from/to are character (holder) ids)
 *   items {sub: "defof", item}      READ: the definition of an item instance
 *   items {sub: "countbase", base}  READ: how many of a base the caller carries
 *
 * And `drop` generalises with a position (ItemService.placeFixture is
 * the fixture form — it never despawns on the timer):
 *
 *   drop {pick, x, z}               a new item on the ground at (x, z)
 *   drop {pick, x, z, fixture: true}  the same, placed as a fixture
 */

import { z } from "zod";
import type { ItemDefs } from "../items/item-defs.js";

export const ItemActionSchema = z.union([
  z.object({ kind: z.literal("item"), action: z.literal("drop"), item: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("item"), action: z.literal("equip"), item: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("item"), action: z.literal("use"), item: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("item"), action: z.literal("unequip"), hand: z.enum(["main", "off"]) }).strict(),
  z.object({ kind: z.literal("item"), action: z.literal("unequip"), slot: z.enum(["head", "chest", "hands", "legs", "ring", "amulet"]) }).strict(),
]);

const pick = z
  .object({
    def: z.string().min(1).max(128).optional(),
    base: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32).optional(),
    rank: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32).optional(),
    source: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32).optional(),
  })
  .strict();

export const ItemPickArgsSchema = pick;
export type ItemPickArgs = z.infer<typeof pick>;

export const LootArgsSchema = z.object({ count: z.number().int().min(1).max(50).optional() }).strict();

/**
 * The `items` command's full args: a definition pick (the browse read)
 * or one bag sub-action. `item` is an ItemStore instance id; `from` /
 * `to` are character (holder) ids — the ids ItemService.take /
 * moveItem / countBase themselves take.
 */
export const ItemsCommandArgsSchema = pick
  .extend({
    sub: z.enum(["take", "move", "defof", "countbase"]).optional(),
    item: z.number().int().positive().optional(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  })
  .strict();
export type ItemsCommandArgs = z.infer<typeof ItemsCommandArgsSchema>;

/** The `drop` command's args: a pick, plus an optional exact position and the fixture form. */
export const DropArgsSchema = pick
  .extend({
    x: z.number().finite().optional(),
    z: z.number().finite().optional(),
    fixture: z.boolean().optional(),
  })
  .strict();
export type DropArgs = z.infer<typeof DropArgsSchema>;

/** Definitions matching a pick, in definition order. */
export function matchDefs(defs: ItemDefs, a: ItemPickArgs): number[] {
  if (a.def !== undefined) {
    const i = defs.indexOf(a.def);
    return i < 0 ? [] : [i];
  }
  const out: number[] = [];
  const from = a.base !== undefined ? defs.ofBase(a.base) : null;
  const n = from ? from.length : defs.count;
  for (let k = 0; k < n; k++) {
    const i = from ? from[k] : k;
    if (a.rank !== undefined && defs.ranks[i] !== a.rank) continue;
    if (a.source !== undefined && defs.sources[i] !== a.source) continue;
    out.push(i);
  }
  return out;
}

/** One definition matching a pick, chosen by `seed` (deterministic), or -1. */
export function pickDef(defs: ItemDefs, a: ItemPickArgs, seed: number): number {
  const m = matchDefs(defs, a);
  return m.length === 0 ? -1 : m[(seed >>> 0) % m.length];
}

/** The `items` command's answer. */
export function describeMatches(defs: ItemDefs, a: ItemPickArgs): string {
  const m = matchDefs(defs, a);
  if (m.length === 0) return "no items match";
  const sample = m.slice(0, 5).map((i) => `${defs.names[i]} [${defs.ranks[i]} ${defs.bases[i]}] ${defs.ids[i]}`);
  return `${m.length} item${m.length === 1 ? "" : "s"}: ${sample.join("; ")}${m.length > 5 ? "; …" : ""}`;
}
