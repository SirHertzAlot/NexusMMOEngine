/**
 * Character module server entry (complete-modularity slice 7).
 *
 * Exports createSystems(ctx) per the module contract. Builds the character
 * domain: CharacterSystem, AnimationSystem, MasterySystem, StatsSystem, and
 * the SQLite-backed character store. The character system owns the
 * ground-height query used by items and creatures modules via lazy
 * callbacks; the store is published on ctx.stores for the dungeons module
 * (dependsOn: character) and server.ts's gateway wiring.
 *
 * Dependencies (via ctx.config.character): data dir, chunk source, world
 * seed/size/bounds, water, game rules, and a lazy body ref for fall damage.
 */
import path from "node:path";
import { CharacterSystem } from "../../packages/engine-core/dist/src/index.js";
import { AnimationSystem } from "../../packages/engine-core/dist/src/animation.js";
import { MasterySystem } from "../../packages/engine-core/dist/src/stats/mastery-system.js";
import { StatsSystem } from "../../packages/engine-core/dist/src/stats/stats-system.js";
import { SqliteCharacterStore } from "../../packages/engine-core/dist/src/characters/index.js";

export function createSystems(ctx) {
  const config = ctx.config?.character ?? {};
  const dataDir = config.dataDir ?? ".";

  // Character persistence (SQLite-backed). Published on ctx.stores: the
  // dungeons module reads it during assembly, and server.ts hands it to
  // the gateway post-assembly.
  const characterStore = new SqliteCharacterStore(path.join(dataDir, "characters.db"));
  ctx.stores.characterStore = characterStore;

  const character = new CharacterSystem({
    onLand: (e, speed) => config.getBodyRef()?.applyFall(ctx.sim, e, speed),
    chunkSource: config.chunkSource,
    worldSeed: config.worldSeed,
    chunkSize: config.chunkSize,
    bounds: config.bounds,
    water: config.water ?? undefined,
  });

  const animation = new AnimationSystem();
  const mastery = new MasterySystem(config.rules.skills, Date.now, config.rules.disciplines.disciplines);
  const stats = new StatsSystem();

  return { character, animation, mastery, stats };
}

export function dispose(ctx) {
  ctx.stores.characterStore?.close?.();
  delete ctx.stores.characterStore;
}
