/**
 * The shared vocabulary: the few types the engine and a game's systems must
 * agree on, with no system behind them (roadmap ES5).
 *
 * A kit owns its systems; what it cannot own alone is the shape of what it
 * hands the rest of the world. `Weapon` is what a striker swings, and every
 * place that produces one — an item's definition, a creature's natural
 * weapon, a dungeon's loadout — has to describe it the same way as the
 * combat system that consumes it. `LifeEvent` is the same for a death: loot,
 * quests and a dungeon's run all react to one, none of them owning it.
 *
 * These lived in `combat.ts` and `death.ts`, which made nine files across
 * items, quests, dungeons and admin import a combat system's module to name
 * a type. Here they depend on the rules package and nothing else, so a kit
 * imports the vocabulary from the engine and the engine never imports the
 * kit — the direction the split needs.
 */

import type { DamageInput, DeathInput, DeathOutcome } from "@mmo-engine/rules";

/** What a striker swings: the rules technique, the item's physics and its reach (m). */
export interface Weapon {
  technique: string;
  item: DamageInput["item"];
  reach: number;
  /** The item family familiarity builds with (its base: "sword", "axe"); absent: none. */
  family?: string;
  /** Optional percentage of defender armour mitigation bypassed on hit (clamped 0..100). */
  armourPenetrationPct?: number;
  /** Optional percentage reduction of attack stamina drain (clamped 0..50). */
  staminaReductionPct?: number;
}

/** A death or a return, as the rest of the world hears about it. */
export interface LifeEvent {
  tick: number;
  target: number;
  state: "dead" | "alive";
  killer?: number;
  /** Tick the body respawns (dead events). */
  respawnAt?: number;
  outcome?: DeathOutcome;
  /** Where it fell (dead events). */
  x?: number;
  z?: number;
  /** What killed it (dead events). */
  cause?: DeathInput;
}
