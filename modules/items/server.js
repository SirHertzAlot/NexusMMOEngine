/**
 * Items module server entry (complete-modularity slice 2).
 *
 * Exports createSystems(ctx) per the module contract. Builds the ItemService
 * and LootDropper from bootstrap config (game rules, data dir, ground height,
 * ledger, creature kinds, wallet) and runs the startup sequence (clear strays,
 * restore from ledger). server.ts no longer constructs items inline.
 */
import { ItemService, LootDropper, loadItemDefs } from "../../packages/engine-core/dist/src/items/index.js";

export function createSystems(ctx) {
  const config = ctx.config?.items ?? {};
  const { defs, summary } = loadItemDefs(config.dataDir, config.rules);
  ctx.log(`[${summary}]`);
  const items = new ItemService({
    defs,
    loot: config.rules.loot,
    tickHz: config.tickHz ?? 30,
    groundHeightAt: config.groundHeightAt,
    rankOrder: config.rankOrder,
  });
  // Startup sequence: clear strays from a restored snapshot, then restore
  // every item from the ledger (bags, hands, ground).
  const strays = items.clearStrayGroundItems(ctx.sim);
  if (strays > 0) ctx.log(`[items] cleared ${strays} ground item(s) left from before the restart`);
  const restored = items.restore(ctx.sim, config.ledger.load());
  items.attachLedger(config.ledger);
  if (restored > 0) ctx.log(`[items] restored ${restored} item(s) from the ledger`);

  const dropper = new LootDropper({
    items,
    defs,
    creatures: config.rules.creatures.creatures,
    tables: config.rules.loot.tables ?? {},
    kindOf: config.kindOf,
    // The economy module (a dependency, so assembled first) publishes the
    // wallet on ctx.stores during its createSystems.
    wallet: ctx.stores.wallet,
  });
  return { items, dropper };
}
