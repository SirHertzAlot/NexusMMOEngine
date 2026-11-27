/**
 * Dungeons module server entry (complete-modularity slice 3).
 *
 * Exports createSystems(ctx) per the module contract. Builds the dungeon
 * pool, the InstanceManager, and the SQLite-backed instance-result store.
 * The manager is a gateway extension (not a tick system) — server.ts passes
 * it to the Gateway via the assembled module. The result store is published
 * on ctx.stores for server.ts's world-client reporter.
 *
 * Dependencies (via ctx.config.dungeons): content dir, data dir, game
 * accessor, instance host, and callbacks. Callbacks are lazy because the
 * gateway doesn't exist yet at assembly time. The character store comes
 * from ctx.stores (dependsOn: character, so it is built first).
 */
import path from "node:path";
import { loadDungeonContent } from "../../packages/engine-core/dist/src/dungeons/content.js";
import { DungeonPool } from "../../packages/engine-core/dist/src/dungeons/pool.js";
import { InstanceManager } from "../../packages/engine-core/dist/src/dungeons/manager.js";
import { SqliteInstanceResultStore } from "../../packages/engine-core/dist/src/dungeons/results.js";
// The fighting a run gets. `dungeons/instance.ts` knows only the slot
// (dungeons/combat-slot.js); this is the engine's own wiring of it, and the
// only thing a game replaces to fight differently underground. It moves
// into @mmo-engine/kit-combat with the systems it builds.
import { defaultDungeonCombat } from "@mmo-engine/kit-combat";
// The chests, breakables and veins a run gets. Same shape as the fighting
// above: `dungeons/instance.ts` knows only the slot (dungeons/world-slot.js),
// and this is that kit's own wiring of it.
import { defaultDungeonWorld } from "@mmo-engine/kit-economy";

export function createSystems(ctx) {
  const config = ctx.config?.dungeons ?? {};
  const dataDir = config.dataDir ?? ".";
  const dungeonPool = new DungeonPool(dataDir + "/dungeons");

  // Instance results (SQLite-backed): runs commit here; the world reporter
  // flushes them. Published on ctx.stores for server.ts.
  const instanceResults = new SqliteInstanceResultStore(path.join(dataDir, "instances.db"));
  ctx.stores.instanceResults = instanceResults;

  // The character module builds this first (see dependsOn in module.json).
  const characterStore = ctx.stores.characterStore;
  if (!characterStore) throw new Error("dungeons: the character module must be enabled (ctx.stores.characterStore is missing)");

  const dungeons = new InstanceManager({
    content: loadDungeonContent(config.dungeonDir),
    pool: dungeonPool,
    ...(config.scale ? { scale: config.scale } : {}),
    game: config.getGame,
    credentialStore: config.credentialStore,
    characterStore,
    partyOf: (name) => config.getGateway().partyOf(name),
    weaponOf: (character) => config.getWeaponOf(character),
    armourOf: (character, kind) => config.getArmourOf(character, kind),
    combat: config.combat ?? defaultDungeonCombat,
    world: config.world ?? defaultDungeonWorld,
    lootPool: () => config.getLootPool(),
    chestPool: () => config.getChestPool(),
    grant: (character, def) => config.grantItem(character, def),
    train: config.train,
    endpoint: (p) => `ws://${config.instanceHost}:${p}`,
    results: instanceResults,
    log: (l) => ctx.log(l),
  });
  ctx.log(`[dungeons] ${dungeonPool.entries.length} layout(s) in the pool (${dataDir}/dungeons)`);

  return { dungeons };
}

export function dispose(ctx) {
  ctx.stores.instanceResults?.close?.();
  delete ctx.stores.instanceResults;
}
