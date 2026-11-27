/**
 * What the server reads back from the enabled modules (roadmap ES4).
 *
 * Module assembly returns two bags keyed by name: the tick systems and the
 * gateway extensions. Before this table, `server.ts` reached into them by
 * string with a cast per read — 22 of them — which cost two things. A
 * renamed or dropped system was an `undefined` that surfaced as a
 * `TypeError` in the first tick that touched it, and the cast let every
 * read claim a type nothing checked.
 *
 * The table below is the engine's own list of what its entry point reads:
 * the key, the module that provides it, whether it is a tick system or a
 * gateway extension, and whether the server can run without it. It is not
 * a list of what a module may provide — a module declares that in its own
 * `module.json`. It is the honest statement of what *our* server couples
 * to, which is what the engine/game split has to shrink: a game that drops
 * our combat module can read this table and see every row to change, and a
 * game with its own entry point writes its own table and uses none of it.
 *
 * `required: false` means the server boots without it and the features it
 * carries are simply absent. `required: true` means the boot cannot get as
 * far as listening without it.
 *
 * Shrinking the required list is the measure of the split (ES5–ES8): a
 * game that wants none of our combat, items, quests or dungeons should not
 * have to enable the modules that provide them. Booting with `core` alone
 * prints the list, which is why the error names every missing service at
 * once instead of the first. What is left is `physics` (the streamer holds
 * a chunk back until its terrain colliders are in) and `character` with
 * `mastery` (players need ground height, bounds and a sheet), both of
 * which are the engine's own rather than a game's design.
 */

import { openServiceRegistry, type ServiceDecl, type ServiceRegistry } from "@mmo-engine/sdk";
import type { BodyPort, MagicPort, ResidentPort, VendorPort, WalletPort } from "./net/ports.js";
import type { GatheringRules } from "@mmo-engine/rules";
import type { ResourceNodeSpec } from "./vocabulary.js";
import type { SimWorld } from "./world.js";
import type { TelegraphSpec } from "./vocabulary.js";
import type { PhysicsSystem } from "./systems.js";
import type { CreatureSystem } from "./creatures.js";
import type { BotSystem } from "./bots.js";
import type { CrowdSystem } from "./navigation/crowd-system.js";
import type { NavigationSystem } from "./navigation/system.js";
import type { CharacterSystem } from "./index.js";
import type { MasterySystem } from "./stats/mastery-system.js";
import type { ItemService } from "./items/index.js";
import type { LootDropper } from "./items/loot-dropper.js";
import type { InstanceManager } from "./dungeons/manager.js";
import type { QuestService } from "./quests/quest-service.js";
import type { CivicService } from "./civic/index.js";

/**
 * What the host itself calls on a game's combat and telegraphs (`ES5f`).
 *
 * These are not the gateway's ports. The gateway drains hits and events;
 * `server.ts` asks who struck last — for a fall's credit, for a broken
 * prop's loot — and asks for a warning cone to be cast or cancelled. Two
 * readers, two demands, both written out rather than naming the systems that
 * answer them: the registry was the last place in the engine's own
 * wiring that did. `body` is the gateway's `BodyPort`, because the host
 * resolves it here and passes that same object down.
 */
export interface CombatService {
  /** The last entity to damage `e`, if known. */
  lastAttacker(e: number): number | undefined;
}

export interface TelegraphService {
  /** Warn of an attack that lands later; returns its id. */
  cast(sim: SimWorld, spec: TelegraphSpec, tick: number): number;
  /** Drop every telegraph `source` raised; returns how many. */
  cancelFrom(source: number, tick: number): number;
}

/**
 * What the host asks of a game's gathering (`ES5k`).
 *
 * Not the gateway's `GatheringPort`, which is about a player reaching a node
 * — views, a gather, a cast bar, a pouch message. These are the host's own
 * nine: the pouch is where mending a building spends its materials, where a
 * quest's reward lands, and what the world record carries, and the host
 * registers a scene's nodes as it spawns them and re-reads the rules when
 * they reload.
 */
export interface GatheringService {
  /** How much of `material` `holder` is carrying. */
  countOf(holder: number, material: string): number;
  /** Take `qty` of `material` out of the pouch; false if it isn't there. */
  take(holder: number, material: string, qty: number): boolean;
  /** Put `qty` of `material` in; false if the pouch has no room. */
  grant(holder: number, material: string, qty: number): boolean;
  /** Whether `qty` more of `material` would fit. Changes nothing. */
  hasRoom(holder: number, material: string, qty: number): boolean;
  /** Spend `qty` of `material` on something; false if it isn't there. */
  spend(holder: number, material: string, qty: number): boolean;
  /** Make entity `eid` the node `key` (a scene's tree stand, ore vein, fishing spot). */
  register(eid: number, key: string, spec: ResourceNodeSpec): void;
  /** Re-read the gathering rules after a hot reload (EG11). */
  setRules(rules: GatheringRules): void;
  /** Drop a character's cached pouch, so the next read loads it again. */
  forgetPouch(holder: number): void;
}

/**
 * Where a game's gathering keeps what it has saved, as the world record
 * needs it (`ES5k`).
 *
 * The host carries these rows between the region and the world server and
 * never reads inside them, so they are `unknown` going each way: validating a
 * recalled pouch or a node stock is the business of whatever wrote it, which
 * is also the only thing that knows what a valid one looks like.
 */
export interface GatheringRecords {
  /** A character's pouch, for the world record's `extras.pouch`. */
  loadPouch(charId: number): Record<string, number>;
  /** Put a recalled pouch back, dropping whatever it does not recognise. */
  replacePouch(charId: number, pouch: unknown): void;
  /** Every node's stock, for the range snapshot (PL3a: the stocks are the range's, held by the world). */
  allNodes(): readonly unknown[];
}

/** Every service the server reads, and what it is. */
export interface EngineServices {
  items: ItemService;
  wallet: WalletPort;
  vendor: VendorPort;
  body: BodyPort;
  magic: MagicPort;
  telegraphs: TelegraphService;
  combat: CombatService;
  creatures: CreatureSystem;
  bots: BotSystem;
  crowd: CrowdSystem;
  physics: PhysicsSystem;
  navigation: NavigationSystem;
  character: CharacterSystem;
  mastery: MasterySystem;
  residents: ResidentPort;
  gathering: GatheringService;
  dropper: LootDropper;
  dungeons: InstanceManager;
  quests: QuestService;
  civic: CivicService;
}

export const SERVICE_TABLE: readonly ServiceDecl[] = [
  // Items and money.
  { key: "items", module: "items", kind: "system", required: false, what: "bags, item definitions, provenance" },
  { key: "dropper", module: "items", kind: "extension", required: false, what: "what a kill leaves on the ground" },
  { key: "wallet", module: "economy", kind: "system", required: false, what: "coin, which the gateway and the vendors read" },
  { key: "vendor", module: "economy", kind: "system", required: false, what: "shops, attached to a resident who keeps one" },

  // The combat cluster.
  { key: "body", module: "combat", kind: "system", required: false, what: "body parts and wounds, for the physics fall callback" },
  { key: "magic", module: "combat", kind: "system", required: false, what: "spells, re-read by the rules reloader" },
  { key: "telegraphs", module: "combat", kind: "system", required: false, what: "the warning cones a creature casts before it strikes" },
  { key: "combat", module: "combat", kind: "system", required: false, what: "who struck whom last, for kill credit" },

  // Creatures and their movement.
  { key: "creatures", module: "creatures", kind: "system", required: false, what: "wild creatures, raids, respawns" },
  { key: "bots", module: "creatures", kind: "system", required: false, what: "the practice bots (MMO_BOTS=0 leaves them out)" },
  { key: "crowd", module: "creatures", kind: "system", required: false, what: "steered movement, when a navigation backend is up" },

  // The world itself.
  { key: "physics", module: "physics", kind: "system", required: true, what: "the Jolt world, and the terrain collider hook the streamer needs" },
  { key: "navigation", module: "physics", kind: "system", required: false, what: "pathfinding; the debugger answers \"unknown\" without it" },
  { key: "character", module: "character", kind: "system", required: true, what: "players: ground height, bounds, movement" },
  { key: "mastery", module: "character", kind: "system", required: true, what: "what a character has got better at" },
  { key: "residents", module: "residents", kind: "system", required: false, what: "the towns' people (off without a scene and a baked manifest)" },
  { key: "gathering", module: "gathering", kind: "system", required: false, what: "resource nodes and the materials pouch (no module, no pouch: a building cannot be mended)" },

  // Gateway extensions: consumed directly, never ticked.
  { key: "dungeons", module: "dungeons", kind: "extension", required: false, what: "dungeon instances" },
  { key: "quests", module: "quests", kind: "extension", required: false, what: "quests and dialog" },
  { key: "civic", module: "civic", kind: "extension", required: false, what: "contracts, bridge wear, provenance" },
];

export type EngineServiceRegistry = ServiceRegistry<EngineServices>;

/** Read the assembled modules through {@link SERVICE_TABLE}. */
export function openEngineServices(assembled: {
  byName: Readonly<Record<string, unknown>>;
  extensions: Readonly<Record<string, unknown>>;
  modules: readonly string[];
}): EngineServiceRegistry {
  return openServiceRegistry<EngineServices>(SERVICE_TABLE, {
    systems: assembled.byName,
    extensions: assembled.extensions,
    modules: assembled.modules,
  });
}
