/**
 * The fighting this engine ships, wired for a dungeon run (roadmap ES5e).
 *
 * This is the only file left that constructs `CombatSystem`, `DeathSystem`
 * and `StaminaSystem` for a dungeon, and it is deliberately the only thing
 * standing between them and `@mmo-engine/kit-combat`: nothing on the
 * engine's boot path imports it. `dungeons/instance.ts` knows the slot in
 * `./combat-slot.js` and nothing else; `modules/dungeons/server.js` passes
 * this factory in, the way a game passes its own.
 *
 * When the combat kit exists, this file moves into it unchanged. A game that
 * writes its own fighting writes its own in its place, reading the same
 * context and returning the same two things.
 */

import { CombatSystem } from "../combat.js";
import { DeathSystem } from "../death.js";
import { StaminaSystem } from "../stats/stamina-system.js";
import type { DungeonCombat, DungeonCombatContext, DungeonCombatFactory } from "@mmo-engine/engine-core";

/**
 * Build this engine's combat, death and stamina systems for one run.
 *
 * The wiring is what `instance.ts` used to do inline, unchanged: stamina
 * backs combat's drains, combat tells death who struck last, and death asks
 * the run where to put a body and how long to wait.
 */
export const defaultDungeonCombat: DungeonCombatFactory = (ctx: DungeonCombatContext): DungeonCombat => {
  const stamina = new StaminaSystem();
  // Read once per run, like the open world's: a rules reload starts new runs.
  const tuning = { resolution: ctx.rules.combat.resolution, unarmed: ctx.rules.items.unarmed };
  const combat = new CombatSystem(ctx.tickHz, stamina, {
    hooks: ctx.hooks,
    weaponOf: (e) => ctx.weaponOf(e),
    armourOf: (e, kind) => ctx.armourOf(e, kind),
    techniqueKind: (t) => ctx.rules.combat.techniques[t]?.damageKind,
    tuning: () => tuning,
  });
  const death = new DeathSystem(
    ctx.hooks,
    ctx.tickHz,
    (e) => combat.lastAttacker(e),
    (sim, e) => ctx.place(sim, e),
    (e) => ctx.respawnSeconds(e),
    (sim, event) => ctx.onDeath(sim, event),
  );
  return {
    systems: [combat, death, stamina],
    lastAttacker: (e) => combat.lastAttacker(e),
  };
};
