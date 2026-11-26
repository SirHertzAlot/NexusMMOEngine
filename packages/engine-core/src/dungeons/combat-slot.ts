/**
 * What a dungeon run asks of a game's fighting (roadmap ES5e).
 *
 * A dungeon run is a host, the same as the region gateway: its own
 * `SimWorld`, its own `Gateway` on its own port, its own tick order. The
 * region gateway stopped naming a system class in `ES4c`/`ES4d` — it asks
 * for ports and works with whatever offers them — but the run still
 * *constructed* `CombatSystem`, `DeathSystem` and `StaminaSystem` itself,
 * which is a harder knot: you cannot ask for a system by port and also be
 * the one who decides how it is built.
 *
 * So the run declares a slot instead. It hands a game everything it knows
 * about itself — the tick rate, the rules and hooks it was opened with, what
 * an entity swings, what its armour stops, which entities are its creatures,
 * where a respawning body goes — and takes back the systems to run and the
 * one thing it needs to ask afterwards: who struck last, for kill credit and
 * for a broken prop's loot.
 *
 * A run with no factory has no fighting: creatures stand there, nothing takes
 * damage, and the run ends on its timer. That is the same rule the ports
 * follow — a port nothing offers is a feature this run lacks, not an error —
 * and it is what lets the combat systems leave for `@mmo-engine/kit-combat`
 * without the dungeon code following them.
 */

import type { RuleHooks, Rules } from "@mmo-engine/rules";
import type { SimSystem } from "../systems.js";
import type { LifeEvent, Weapon } from "../vocabulary.js";
import type { SimWorld } from "../world.js";

/** The damage kinds armour is asked about. */
export type ArmourKind = "cut" | "blunt" | "thrust";

/** What the run tells a game's fighting about itself, once, at construction. */
export interface DungeonCombatContext {
  /** The run's tick rate, Hz. */
  readonly tickHz: number;
  /** The rules the run was opened with (combat resolution, item bases, unarmed). */
  readonly rules: Rules;
  /** The game's rule hooks, as `loadGameRules` resolved them. */
  readonly hooks: RuleHooks;
  /** What entity `e` swings; null: fists. */
  weaponOf(e: number): Weapon | null;
  /** The share of a blow `e`'s worn armour lets through (1: none). */
  armourOf(e: number, kind?: ArmourKind): number;
  /** Whether `e` is one of the run's creatures rather than a player. */
  isCreature(e: number): boolean;
  /**
   * Put a respawning body down; false lets it rise where it fell.
   *
   * The run sends a player back to the entrance and leaves a creature
   * lying, because a dead creature in a dungeon stays dead.
   */
  place(sim: SimWorld, e: number): boolean;
  /** Respawn delay for `e`, seconds; undefined keeps the rules' own. */
  respawnSeconds(e: number): number | undefined;
  /** Tell the run a death happened: its kills, its deaths, and the loot. */
  onDeath(sim: SimWorld, event: LifeEvent): void;
}

/** What a game's fighting gives back, built once per run. */
export interface DungeonCombat {
  /**
   * The systems to run, in tick order.
   *
   * They are spliced in after the run's intents and before its integration,
   * where `CombatSystem`, `DeathSystem` and `StaminaSystem` used to sit. A
   * game that wants a different order inside that span returns them in it.
   */
  readonly systems: readonly SimSystem[];
  /**
   * Who last struck `e`, if anyone.
   *
   * The run asks twice: the loot a kill rolls goes to the killer, and so
   * does the loot from a broken barrel.
   */
  lastAttacker(e: number): number | undefined;
}

/** How a game supplies the fighting for one dungeon run. */
export type DungeonCombatFactory = (context: DungeonCombatContext) => DungeonCombat;

/** A run whose game supplied no fighting: nothing strikes, nothing dies. */
export const NO_DUNGEON_COMBAT: DungeonCombat = {
  systems: [],
  lastAttacker: () => undefined,
};
