/**
 * Creatures module server entry (complete-modularity slice 6).
 *
 * Exports createSystems(ctx) per the module contract. Builds the creatures
 * domain: CreatureSystem, BotSystem (conditional), CrowdSystem (conditional),
 * NeedsSystem. The creature system is shared by combat, death, dungeons,
 * and the gateway's admin spawn via lazy callbacks.
 *
 * Dependencies (via ctx.config.creatures): game rules, nav backend,
 * character ground height, bot config, spawn point, character catalog,
 * player abilities.
 */
import { CreatureSystem } from "../../packages/engine-core/dist/src/creatures.js";
import { BotSystem } from "../../packages/engine-core/dist/src/bots.js";
import { CrowdSystem } from "../../packages/engine-core/dist/src/navigation/crowd-system.js";
import { NeedsSystem } from "../../packages/engine-core/dist/src/stats/needs-system.js";

export function createSystems(ctx) {
  const config = ctx.config?.creatures ?? {};
  const rules = config.rules;
  // Nav backend is shared by the physics module (creatures depends on physics).
  const navBackend = ctx.shared?.navBackend;
  const hasCrowd = navBackend?.crowd !== undefined;

  const bots = config.botCount > 0
    ? [
        new BotSystem({
          count: config.botCount,
          home: config.botHome,
          radius: config.botRadius,
          catalog: config.characterCatalog,
          groundHeightAt: config.groundHeightAt,
          abilities: config.playerAbilities,
          steer: hasCrowd,
        }),
      ]
    : [];
  if (config.botCount > 0) ctx.log(`[bots] ${config.botCount} bots (sparring pairs and wanderers)`);

  const crowd = hasCrowd ? [new CrowdSystem(navBackend.crowd)] : [];

  const creatures = new CreatureSystem({
    creatures: rules.creatures.creatures,
    bases: rules.items.bases,
    groundHeightAt: config.groundHeightAt,
    steer: hasCrowd,
    // Wildlife (docs/WILDLIFE.md): the day clock, warnings through the telegraph system, the water, the models, the settlements.
    massPower: rules.combat.damage.massPower,
    ai: rules.creatures.ai,
    timeOfDay: config.timeOfDay,
    warn: config.warn,
    cancelWarn: config.cancelWarn,
    attackerOf: config.attackerOf,
    waterDepthAt: config.waterDepthAt,
    waterSurfaceAt: config.waterSurfaceAt,
    modelOf: config.modelOf,
    settlements: config.settlements,
  });

  const needs = new NeedsSystem(rules.needs, config.waterSurfaceAt);

  const systems = { creatures, needs };
  if (bots.length > 0) systems.bots = bots[0];
  if (crowd.length > 0) systems.crowd = crowd[0];
  return systems;
}
