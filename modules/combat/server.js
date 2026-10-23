/**
 * Combat module server entry (complete-modularity slice 5).
 *
 * Exports createSystems(ctx) per the module contract. Builds the full combat
 * cluster: stamina, body, magic, abilities, status, telegraphs, duels, combat,
 * death. These share components and the combatDamage delegate — they move as
 * one coherent domain, not nine independent modules.
 *
 * Dependencies (via ctx.config.combat): game rules, hooks delegate,
 * combat skills, and lazy callbacks for weapon/armor/creatures/gateway.
 * The status damage/heal callbacks touch Health/God components via ctx.sim.
 */
import { hasComponent } from "bitecs";
import { CombatSystem } from "../../packages/engine-core/dist/src/combat.js";
import { AbilitySystem } from "../../packages/engine-core/dist/src/abilities.js";
import { StatusSystem } from "../../packages/engine-core/dist/src/status.js";
import { TelegraphSystem } from "../../packages/engine-core/dist/src/telegraph.js";
import { DuelSystem } from "../../packages/engine-core/dist/src/duel.js";
import { BodySystem } from "../../packages/engine-core/dist/src/body.js";
import { DeathSystem } from "../../packages/engine-core/dist/src/death.js";
import { MagicSystem } from "../../packages/engine-core/dist/src/magic.js";
import { StaminaSystem } from "../../packages/engine-core/dist/src/stats/stamina-system.js";
import { Health, God, CharacterRef } from "../../packages/engine-core/dist/src/components.js";

export function createSystems(ctx) {
  const config = ctx.config?.combat ?? {};
  const rules = config.rules;
  const sim = ctx.sim;

  const stamina = new StaminaSystem();

  const body = new BodySystem(rules.body, config.hooks, rules.appearance, config.combatSkills);

  const magic = new MagicSystem(rules.spells);

  // Worn armour: bots and props wear nothing (factor 1).
  const armourOf = (e) => {
    if (!hasComponent(sim.ecs, CharacterRef, e)) return 1;
    return config.getWornFactor(CharacterRef.idHi[e] * 4294967296 + CharacterRef.idLo[e]);
  };
  const combatDamage = {
    hooks: config.hooks,
    weaponOf: config.getWeaponOf,
    armourOf,
    skills: config.combatSkills,
    body,
    techniques: () => Object.keys(rules.combat.techniques),
    // Blow resolution (EG6): combat.json's resolution and items.json's unarmed, live across reloads.
    tuning: config.getCombatTuning,
  };

  const abilities = new AbilitySystem(30);
  const status = new StatusSystem(
    30,
    (t, amount) => {
      if (hasComponent(sim.ecs, Health, t) && !hasComponent(sim.ecs, God, t))
        Health.current[t] = Math.max(0, Health.current[t] - amount);
    },
    (t, amount) => {
      if (hasComponent(sim.ecs, Health, t)) Health.current[t] = Math.min(Health.max[t], Health.current[t] + amount);
    },
  );
  const telegraphs = new TelegraphSystem(30);
  const duels = new DuelSystem(30);

  // Consensual PvP: players may only hurt players they are dueling (or
  // marked hostile); player-vs-creature blows are unchanged. Status
  // effects: the attacker's power buffs and the defender's armour buffs
  // scale the landed blow.
  combatDamage.canHit = (a, b) =>
    hasComponent(sim.ecs, CharacterRef, a) && hasComponent(sim.ecs, CharacterRef, b) ? duels.canHit(a, b) : true;
  combatDamage.damageScale = (a, b) => status.modifier(a, "power").mul * status.modifier(b, "armour").mul;

  const combat = new CombatSystem(30, stamina, combatDamage);

  // Death: players respawn at the gateway's spawn grid, bots rise where
  // they fell. Drops and quest kills route through lazy module refs. A
  // duelist felled by their opponent loses the duel instead of dying.
  const death = new DeathSystem(
    config.hooks,
    30,
    (e) => combat.lastAttacker(e),
    (s, e) => config.getCreaturesPlace(s, e) || config.getGateway().respawnPlayer(s, e),
    (e) => config.getRespawnSeconds(e),
    (s, ev) => {
      config.getDropper()?.onDeath(s, ev);
      config.getQuests()?.onDeath(s, ev, (e) => config.getKindOf(e));
    },
    body,
    duels
  );

  return { stamina, body, magic, abilities, status, telegraphs, duels, combat, death };
}
