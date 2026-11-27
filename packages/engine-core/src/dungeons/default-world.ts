/**
 * The chests, breakables and veins this engine ships, wired for a dungeon
 * run (roadmap ES5j).
 *
 * This is the only file left that constructs `ChestSystem`, `BreakSystem`
 * and `GatheringSystem` for a dungeon, and it is deliberately the only thing
 * standing between them and `@mmo-engine/kit-economy`: nothing on the
 * engine's boot path imports it. `dungeons/instance.ts` knows the slot in
 * `./world-slot.js` and nothing else; `modules/dungeons/server.js` passes
 * this factory in beside the fighting, the way a game passes its own.
 *
 * When the economy kit exists, this file moves into it unchanged. A game
 * that wants its own chests writes its own in its place, reading the same
 * context and returning the same six things.
 */

import { BreakSystem, breakDefsOf, ChestSystem } from "../interact/index.js";
import { GatheringSystem } from "../gathering/index.js";
import type { DungeonWorld, DungeonWorldContext, DungeonWorldFactory } from "./world-slot.js";

/**
 * Build this engine's chest, break and gathering systems for one run.
 *
 * The wiring is what `instance.ts` used to do inline, unchanged: a chest
 * holds the run's own table and never refills, a break asks the fighting who
 * struck last, and the veins come from the run's gathering rules. The tick
 * order is the one the run always had — breaks, then chests, then veins.
 */
export const defaultDungeonWorld: DungeonWorldFactory = (ctx: DungeonWorldContext): DungeonWorld => {
  const gathering = ctx.veins
    ? new GatheringSystem({
        reachM: ctx.rules.gathering.reachM,
        cooldownMs: ctx.rules.gathering.cooldownSeconds * 1000,
        pouchMax: ctx.rules.gathering.pouchMax,
        trainPerTier: ctx.rules.gathering.trainDifficultyPerTier,
        now: () => ctx.now(),
      })
    : null;
  const chests = new ChestSystem({
    reachM: ctx.chestReachM,
    drop: (_s, _table, _x, _z, owner) => ctx.openChest(owner),
  });
  const breaks = new BreakSystem(breakDefsOf(ctx.props), {
    killerOf: (e) => ctx.killerOf(e),
    onBreak: (_s, ev) => ctx.onBreak(ev.killer, ev.loot !== undefined),
    spawnDebris: (s, debris, x, y, z, yaw) => ctx.spawnDebris(s, debris, x, y, z, yaw),
  });
  return {
    systems: gathering ? [breaks, chests, gathering] : [breaks, chests],
    gathers: gathering !== null,
    resourceNodes: () => gathering?.size ?? 0,
    // A run's chest is the run's: one table, and it never refills.
    registerChest: (eid, key) => chests.register(eid, key, { table: "run", refillSeconds: 1e9 }),
    chestIsOpen: (eid) => chests.isOpen(eid),
    rebindChest: (was, now) => chests.rebind(was, now),
    registerVein: (eid, key, vein) =>
      gathering?.register(eid, key, {
        kind: vein.kind,
        material: vein.kind,
        tier: vein.tier,
        skill: "mining",
        stock: 3,
        regrowHours: 0,
        halfX: 0.5,
        halfZ: 0.5,
      }),
  };
};
