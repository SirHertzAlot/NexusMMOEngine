/**
 * gathering module — server entry (roadmap ES5k).
 *
 * Builds the EG1 gathering domain: the resource nodes a scene places (tree
 * stands, ore veins, fishing spots) and the materials pouch a player fills
 * from them, both persisted in `gathering.db`.
 *
 * `server.ts` used to build these two itself, from `provided.core`, which
 * made gathering the last economy system the engine's entry point named.
 * It asks for the `gathering` service now and goes without when this module
 * is off: no pouch, so no mending a building and no gathering reward, and
 * the nodes a scene names are simply not registered.
 *
 * Two things cross back the other way through `ctx.stores`, because the host
 * carries them between the region and the world server and does not read
 * inside them (`GatheringRecords`): a character's pouch, for the world
 * record's `extras.pouch`, and every node's stock, for the range snapshot.
 * Recall runs long before assembly, so the host keeps the recalled stocks
 * and this module seeds them the moment it opens the store — which is what
 * the old code did by opening and closing `gathering.db` early.
 */
import fs from "node:fs";
import path from "node:path";
import { GatheringSystem, materialCountsOf, nodeStocksOf, SqliteGatheringStore } from "@mmo-engine/kit-economy";

export function createSystems(ctx) {
  const cfg = ctx.config?.gathering ?? {};
  // No configured dataDir means a harness, not a server: ./data (gitignored)
  // rather than the working directory. See docs/MODULES.md, "Where a store lives".
  const dataDir = typeof cfg.dataDir === "string" ? cfg.dataDir : "./data";
  fs.mkdirSync(dataDir, { recursive: true });
  const rules = cfg.rules ?? {};

  const store = new SqliteGatheringStore(path.join(dataDir, "gathering.db"));
  // Node stocks recalled from the world (PL3a) land before anything reads
  // them: the host handed us whatever its snapshot carried, and only this
  // side knows which rows are valid.
  const recalled = cfg.recalledNodes?.();
  if (recalled !== undefined) store.replaceNodes(nodeStocksOf(recalled));

  // Reach, pace, pouch size, training and regrow pace come from
  // content/rules/gathering.json (hot-reloaded, EG11: the host calls
  // setRules on the service).
  const gathering = new GatheringSystem({
    reachM: rules.reachM,
    cooldownMs: rules.cooldownSeconds * 1000,
    pouchMax: rules.pouchMax,
    trainPerTier: rules.trainDifficultyPerTier,
    regrowCheckSeconds: rules.regrowCheckSeconds,
    regrowHourMs: rules.regrowHourSeconds * 1000,
    store,
    // The respawn pool and the mastery sheets are the host's, handed down:
    // a node's regrow shares the pool every respawning thing uses, and a
    // gather trains the node's skill on the gatherer's own sheet.
    pool: cfg.pool,
    train: cfg.train,
  });

  // What the world record needs, with the validation on this side of the
  // boundary: the host passes the snapshot's rows through untouched.
  ctx.stores.gatheringRecords = {
    loadPouch: (charId) => store.loadPouch(charId),
    replacePouch: (charId, pouch) => store.replacePouch(charId, materialCountsOf(pouch)),
    allNodes: () => store.allNodes(),
  };
  ctx.stores.gatheringStore = store;

  return { gathering };
}

export function dispose(ctx) {
  ctx.stores.gatheringStore?.close?.();
  delete ctx.stores.gatheringRecords;
  delete ctx.stores.gatheringStore;
}
