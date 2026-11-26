/**
 * `@mmo-engine/kit-combat`: the fighting this engine ships with.
 *
 * Nine systems and one dungeon factory, and that is the whole package. They
 * were in `@mmo-engine/engine-core` until the engine stopped being able to
 * name them: a host asks for `combat`, `life`, `abilities`, `telegraphs`,
 * `statuses` or `duels` and takes whatever offers the port, so the systems
 * that answer no longer have to live where the asking happens.
 *
 * Nothing in the engine imports this package. A game picks it up, forks it,
 * replaces one system in it, or ignores it and writes its own — see the
 * README for what each of those costs.
 */

export { AbilitySystem, type AbilityDef } from "./abilities.js";
export {
  ARM_REACH,
  CombatSystem,
  DEFAULT_COMBAT_TUNING,
  FIGHT_DIFFICULTY,
  GUARD_FACTOR,
  PITCH_AIM_DEADZONE,
  PITCH_AIM_HIGH,
  PITCH_AIM_LOW,
  aimFromLookPitch,
  type CombatBody,
  type CombatDamage,
  type CombatStamina,
  type CombatTuning,
  type HitBody,
  type Stance,
} from "./combat.js";
export { DeathRespawnPool, DeathSystem, type DeathBody, type DeathDuels, type DeathRespawnPoolOptions } from "./death.js";
export { DuelSystem } from "./duel.js";
export { BodySystem, FAILED_TEACHES, TREAT_TRAINS_ABOVE, type BodySkills } from "./body.js";
export { blowRng } from "./blow-rng.js";
export { MagicSystem, clampSpellPath, type ActiveIceRing, type ActiveShield } from "./magic.js";
export {
  ATTACK_COST,
  BUILTIN_REGEN,
  DODGE_COST,
  JUMP_COST,
  REGEN_DELAY_TICKS,
  RUN_DRAIN,
  SWIM_DRAIN,
  StaminaSystem,
} from "./stats/stamina-system.js";
export {
  StatusSystem,
  type ActiveStatus,
  type OverTime,
  type StatMod,
  type StatusDef,
} from "./status.js";
export { TelegraphSystem, inShape } from "./telegraph.js";

/** The run-shaped wiring: what `modules/dungeons` puts in a run's combat slot. */
export { defaultDungeonCombat } from "./dungeons/default-combat.js";
