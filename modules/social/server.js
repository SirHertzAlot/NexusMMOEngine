/**
 * Social module — server entry.
 *
 * Builds the social domain's SQLite-backed stores: guilds, friends/blocks,
 * and parties. Gateway-only (no tick systems): the manifest declares an
 * empty systems list, and server.ts reads the stores off ctx.stores
 * post-assembly for gateway wiring.
 *
 * Dependencies (via ctx.config.social): dataDir.
 */
import path from "node:path";
import { SqliteGuildStore } from "../../packages/engine-core/dist/src/guild-store.js";
import { SqliteSocialStore } from "../../packages/engine-core/dist/src/social-store.js";
import { SqlitePartyStore } from "../../packages/engine-core/dist/src/party-store.js";

export function createSystems(ctx) {
  const dataDir = ctx.config?.social?.dataDir ?? ".";

  const guildStore = new SqliteGuildStore(path.join(dataDir, "guilds.db"));
  const socialStore = new SqliteSocialStore(path.join(dataDir, "social.db"));
  const partyStore = new SqlitePartyStore(path.join(dataDir, "parties.db"));
  ctx.stores.guildStore = guildStore;
  ctx.stores.socialStore = socialStore;
  ctx.stores.partyStore = partyStore;

  return {};
}

export function dispose(ctx) {
  ctx.stores.guildStore?.close?.();
  ctx.stores.socialStore?.close?.();
  ctx.stores.partyStore?.close?.();
  delete ctx.stores.guildStore;
  delete ctx.stores.socialStore;
  delete ctx.stores.partyStore;
}
