/**
 * Dungeons module server entry (complete-modularity slice 3).
 *
 * Exports createSystems(ctx) per the module contract. Builds the dungeon
 * pool and InstanceManager from bootstrap config. The manager is a gateway
 * extension (not a tick system) — server.ts passes it to the Gateway via
 * the assembled module.
 *
 * Dependencies (via ctx.config.dungeons): content dir, data dir, game
 * accessor, stores, instance host, and callbacks. Callbacks are lazy
 * because the gateway doesn't exist yet at assembly time.
 */
import { loadDungeonContent } from "../../packages/engine-core/dist/src/dungeons/content.js";
import { DungeonPool } from "../../packages/engine-core/dist/src/dungeons/pool.js";
import { InstanceManager } from "../../packages/engine-core/dist/src/dungeons/manager.js";

export function createSystems(ctx) {
  const config = ctx.config?.dungeons ?? {};
  const dungeonPool = new DungeonPool(config.dataDir + "/dungeons");

  const dungeons = new InstanceManager({
    content: loadDungeonContent(config.dungeonDir),
    pool: dungeonPool,
    game: config.getGame,
    credentialStore: config.credentialStore,
    characterStore: config.characterStore,
    partyOf: (name) => config.getGateway().partyOf(name),
    weaponOf: (character) => config.getWeaponOf(character),
    armourOf: (character) => config.getArmourOf(character),
    lootPool: () => config.getLootPool(),
    chestPool: () => config.getChestPool(),
    grant: (character, def) => config.grantItem(character, def),
    train: config.train,
    endpoint: (p) => `ws://${config.instanceHost}:${p}`,
    results: config.instanceResults,
    log: (l) => ctx.log(l),
  });
  ctx.log(`[dungeons] ${dungeonPool.entries.length} layout(s) in the pool (${config.dataDir}/dungeons)`);

  return { dungeons };
}
