/**
 * What a dungeon run asks of a game's world props (roadmap ES5j).
 *
 * `ES5e` gave the run a slot for its fighting. This is the same move for the
 * three systems that dress the run rather than fight in it: the chests it
 * places, the barrels and urns that break in it, and the ore veins its
 * dressing bakes. The run was constructing `ChestSystem`, `BreakSystem` and
 * `GatheringSystem` itself, which is the knot `ES4d` left behind — the
 * region gateway asks for those three by port and works with whatever
 * offers them, but the dungeon still decided how they were built, so they
 * could not leave for a kit.
 *
 * So the run declares a slot. It hands a game what it knows about itself —
 * the rules it was opened with, how close a player has to stand to open a
 * chest, whether its dressing bakes veins at all, its prop table, its
 * clock, who struck a prop last — and takes back the systems to run plus
 * the four things it has to ask afterwards: how many veins stand, whether a
 * chest is open, where a chest's entity went when it was swapped for an
 * open model, and that a chest or a vein exists at all.
 *
 * A run with no factory has no props: no chest opens, nothing breaks, and
 * `resourceNodes` is 0. That is the rule the ports and the combat slot
 * follow — absent is a feature this run lacks, never an error — and it is
 * what lets the three systems leave for `@mmo-engine/kit-economy` without
 * the dungeon code following them.
 */

import type { SpawnTable } from "@mmo-engine/scatter";
import type { Rules } from "@mmo-engine/rules";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

/** What the run tells a game's props about itself, once, at construction. */
export interface DungeonWorldContext {
  /** The rules the run was opened with (gathering reach, cooldown, pouch). */
  readonly rules: Rules;
  /** How close a player must stand to open one of the run's chests, metres. */
  readonly chestReachM: number;
  /** Whether the run's dressing bakes resource veins; false: it registers none. */
  readonly veins: boolean;
  /** The run's prop table, for what breaks in it; undefined: it spawns no props. */
  readonly props: SpawnTable | undefined;
  /** The run's wall clock, milliseconds. */
  now(): number;
  /** Who last struck `e` — a broken prop's loot goes to them. */
  killerOf(e: number): number | undefined;
  /**
   * A prop broke: `hasLoot` is whether its archetype had a table to roll.
   *
   * The run counts the break towards its own tally; the loot itself is the
   * breaking system's to roll, the same as it is in the open world.
   */
  onBreak(killer: number | undefined, hasLoot: boolean): void;
  /** Stand a broken prop's `debris` archetype where it was. */
  spawnDebris(sim: SimWorld, debris: string, x: number, y: number, z: number, yaw: number): void;
  /**
   * Roll an opened chest's contents for `owner`; returns how many items.
   *
   * The run owns the chest pool and the roll count, because what a run
   * earned is the run's until the region commits it.
   */
  openChest(owner: number): number;
}

/** One of the run's baked veins, as its dressing describes it. */
export interface DungeonVein {
  /** The material it yields (`iron`, `copper`, …). */
  readonly kind: string;
  /** Its quality tier. */
  readonly tier: number;
}

/** What a game's props give back, built once per run. */
export interface DungeonWorld {
  /**
   * The systems to run, in tick order.
   *
   * They are spliced in after the run's integration and before its walls,
   * where `BreakSystem`, `ChestSystem` and `GatheringSystem` used to sit. A
   * game that wants a different order inside that span returns them in it.
   */
  readonly systems: readonly SimSystem[];
  /**
   * Whether this world gathers at all.
   *
   * False and the run spawns no vein entities: an ore seam nothing can mine
   * is worse than no seam, so the run leaves the dressing out rather than
   * standing props a player can walk up to and not use.
   */
  readonly gathers: boolean;
  /** How many veins stand in the run (0 when it has no gathering). */
  resourceNodes(): number;
  /** Make entity `eid` the run's chest `key`; it holds the run's own table. */
  registerChest(eid: number, key: string): void;
  /** Whether the chest on `eid` has been opened. */
  chestIsOpen(eid: number): boolean;
  /** Follow a chest whose entity was swapped for an open model. */
  rebindChest(was: number, now: number): void;
  /** Make entity `eid` the run's vein `key`. */
  registerVein(eid: number, key: string, vein: DungeonVein): void;
}

/** How a game supplies the props for one dungeon run. */
export type DungeonWorldFactory = (context: DungeonWorldContext) => DungeonWorld;

/** A run whose game supplied no props: no chest opens, nothing breaks, no veins stand. */
export const NO_DUNGEON_WORLD: DungeonWorld = {
  systems: [],
  gathers: false,
  resourceNodes: () => 0,
  registerChest: () => {},
  chestIsOpen: () => false,
  rebindChest: () => {},
  registerVein: () => {},
};
