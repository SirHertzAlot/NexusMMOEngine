/**
 * Quests module server entry (complete-modularity slice 4).
 *
 * Exports createSystems(ctx) per the module contract. Builds the QuestService
 * from bootstrap config. The service is both a SimSystem (checks places and
 * bags) and a GatewayExtension — server.ts passes it to the Gateway via the
 * assembled module.
 *
 * Dependencies (via ctx.config.quests): quest content dir, data dir, game
 * accessor, and lazy callbacks for items. All callbacks are lazy because
 * the items module assembles before quests.
 */
import { QuestService } from "../../packages/engine-core/dist/src/quests/quest-service.js";
import { loadQuestContent } from "../../packages/engine-core/dist/src/quests/content.js";
import { SqliteQuestStore } from "../../packages/engine-core/dist/src/quests/quest-store.js";

export function createSystems(ctx) {
  const config = ctx.config?.quests ?? {};
  const questContent = loadQuestContent(config.questDir);

  const quests = new QuestService({
    content: questContent,
    store: new SqliteQuestStore(config.dataDir + "/quests.db"),
    speciesNear: () => config.getSpeciesNear(),
    itemBases: () => config.getItemBases(),
    countInBag: (character, base) => config.countInBag(character, base),
    grant: (character, base) => config.grantItem(character, base),
    grantGold: (character, amount) => config.grantGold(character, amount),
  });
  ctx.log(
    `[quests] ${Object.keys(questContent.quests).length} quest(s), ` +
    `${Object.keys(questContent.templates).length} template(s), ` +
    `${Object.keys(questContent.npcs).length} npc(s) (${config.questDir})`
  );

  return { quests };
}
