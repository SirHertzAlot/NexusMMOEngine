/**
 * Character module server entry (complete-modularity slice 7).
 *
 * Exports createSystems(ctx) per the module contract. Builds the character
 * domain: CharacterSystem, AnimationSystem, MasterySystem, StatsSystem.
 * The character system owns the ground-height query used by items and
 * creatures modules via lazy callbacks.
 *
 * Dependencies (via ctx.config.character): chunk source, world seed/size/
 * bounds, water, game rules, and a lazy body ref for fall damage.
 */
import { CharacterSystem } from "../../packages/engine-core/dist/src/index.js";
import { AnimationSystem } from "../../packages/engine-core/dist/src/animation.js";
import { MasterySystem } from "../../packages/engine-core/dist/src/stats/mastery-system.js";
import { StatsSystem } from "../../packages/engine-core/dist/src/stats/stats-system.js";

export function createSystems(ctx) {
  const config = ctx.config?.character ?? {};

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
