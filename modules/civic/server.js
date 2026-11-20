/**
 * Civic module server entry: builds SqliteCivicStore + CivicService from
 * moduleCtx.config.civic and ctx.stores.wallet. Publishes ctx.stores.civicStore
 * for shutdown cleanup, state inspection, and fleet snapshot checks.
 */
import { join } from "node:path";
import { loadCivicRules } from "../../packages/rules/dist/src/index.js";
import {
  CivicService,
  SqliteCivicStore,
} from "../../packages/engine-core/dist/src/civic/index.js";

export function createSystems(ctx) {
  const config = ctx.config?.civic ?? {};
  const dataDir = typeof config.dataDir === "string" ? config.dataDir : "./data";
  const store = new SqliteCivicStore(join(dataDir, "civic.db"));
  ctx.stores = ctx.stores ?? {};
  ctx.stores.civicStore = store;

  const rules = config.rules ?? loadCivicRules(config.rulesFile);
  const wallet = ctx.stores.wallet;
  let lastTick = 0;

  const civic = new CivicService({
    rules,
    store,
    dayOf: config.dayOf,
    countMaterial: config.countMaterial ?? (() => 0),
    takeMaterial: config.takeMaterial ?? (() => false),
    grantMaterial: config.grantMaterial ?? (() => false),
    hasMaterialRoom: config.hasMaterialRoom ?? (() => false),
    balanceOf: config.balanceOf ?? ((charId) => wallet?.balanceOf(charId) ?? 0),
    spendGold: config.spendGold ?? ((charId, amount, tick) => wallet?.spend(charId, amount, tick ?? lastTick) ?? false),
    grantGold: config.grantGold ?? ((charId, amount, tick) => wallet?.grant(charId, amount, tick ?? lastTick) ?? false),
    hasBagRoom: config.hasBagRoom ?? (() => false),
    craftAndGrantItem: config.craftAndGrantItem ?? (() => null),
    onSiteStateChange: config.onSiteStateChange,
    activeAvatars: config.activeAvatars,
  });

  ctx.log(
    `[civic] ${rules.sites.length} site(s), ${rules.veins.length} vein template(s), ${rules.foundries.length} foundry(s) (${dataDir})`,
  );

  return { civic };
}

export function dispose(ctx) {
  const store = ctx.stores?.civicStore;
  if (store && typeof store.close === "function") {
    store.close();
  }
  if (ctx.stores && "civicStore" in ctx.stores) {
    delete ctx.stores.civicStore;
  }
}
