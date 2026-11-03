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
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CombatSystem } from "../../packages/engine-core/dist/src/combat.js";
import { AbilitySystem } from "../../packages/engine-core/dist/src/abilities.js";
import { StatusSystem } from "../../packages/engine-core/dist/src/status.js";
import { TelegraphSystem } from "../../packages/engine-core/dist/src/telegraph.js";
import { DuelSystem } from "../../packages/engine-core/dist/src/duel.js";
import { BodySystem } from "../../packages/engine-core/dist/src/body.js";
import { DeathSystem } from "../../packages/engine-core/dist/src/death.js";
import { MagicSystem } from "../../packages/engine-core/dist/src/magic.js";
import { StaminaSystem } from "../../packages/engine-core/dist/src/stats/stamina-system.js";
import { Health, God, CharacterRef, Transform } from "../../packages/engine-core/dist/src/components.js";
import { defineQuery } from "bitecs";

const ABILITIES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "content", "combat", "abilities.json");

/** The ability definitions in content/combat/abilities.json (id, gcdMs, cooldownMs, castMs). */
export function loadAbilityDefs(file = ABILITIES_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return raw.abilities.map((a) => ({ id: a.id, gcdMs: a.gcdMs, cooldownMs: a.cooldownMs, castMs: a.castMs }));
}

/** The statuses the placeholder abilities apply (guard's "guarded"), defined on the status system. */
export function loadAbilityStatuses(file = ABILITIES_FILE) {
  return JSON.parse(readFileSync(file, "utf8")).statuses ?? [];
}

/** The effects the placeholder abilities carry (id -> effect), read from the same file. */
export function loadAbilityEffects(file = ABILITIES_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return new Map(raw.abilities.filter((a) => a.effect).map((a) => [a.id, a.effect]));
}

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

  // The placeholder starter set (content/combat/abilities.json, M5 ability bar): defined once here,
  // with the effect each one has when it fires.
  const effects = loadAbilityEffects();
  const living = defineQuery([Health, Transform]);
  const applyEffect = (e, id, tick) => {
    const eff = effects.get(id);
    if (!eff) return;
    if (eff.kind === "buff") {
      status.apply(e, eff.status, e, tick);
      return;
    }
    if (!hasComponent(sim.ecs, Health, e)) return;
    if (eff.kind === "heal") {
      Health.current[e] = Math.min(Health.max[e], Health.current[e] + eff.amount);
      return;
    }
    if (eff.kind === "damage") {
      // A duelist's strike goes to their opponent and nobody else; otherwise the
      // nearest living thing in reach that this caster may hurt (duel rules apply).
      const foe = duels.opponent(e);
      let best = -1;
      let bestD2 = eff.reachM * eff.reachM;
      for (const t of living(sim.ecs)) {
        if (t === e || (foe !== undefined && t !== foe) || Health.current[t] <= 0 || hasComponent(sim.ecs, God, t)) continue;
        const dx = Transform.px[t] - Transform.px[e];
        const dz = Transform.pz[t] - Transform.pz[e];
        const d2 = dx * dx + dz * dz;
        if (d2 <= bestD2 && combatDamage.canHit(e, t)) {
          best = t;
          bestD2 = d2;
        }
      }
      // Status effects scale the blow the way a melee blow is scaled: the caster's power, the target's armour (guard).
      if (best >= 0) {
        const amount = eff.amount * combatDamage.damageScale(e, best);
        Health.current[best] = Math.max(0, Health.current[best] - amount);
      }
    }
  };
  const abilities = new AbilitySystem(30, (e, id, tick) => applyEffect(e, id, tick));
  for (const def of loadAbilityDefs()) abilities.define(def);
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
  for (const def of loadAbilityStatuses()) status.define(def);
  const telegraphs = new TelegraphSystem(30);
  const duels = new DuelSystem(30);

  // Consensual PvP: players may only hurt players they are dueling (or
  // marked hostile); player-vs-creature blows are unchanged. Status
  // effects: the attacker's power buffs and the defender's armour buffs
  // scale the landed blow.
  combatDamage.canHit = (a, b) =>
    (hasComponent(sim.ecs, CharacterRef, a) && hasComponent(sim.ecs, CharacterRef, b) ? duels.canHit(a, b) : true) && (config.canBreak?.(a, b) ?? true);
  combatDamage.kindScale = (t, kind) => config.kindScale?.(t, kind) ?? 1;
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
