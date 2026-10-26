/**
 * PL3c: guilds, parties, friends and blocks are world records two regions share, through a real
 * WorldCoreImpl: the first fleet boot renumbers what a region had before onto world ids, another region
 * gets it all at boot, edits go uphill version-guarded and reach the other region on refresh, the
 * slower of two writers is told and rereads, and new guilds take world ids.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import Database from "better-sqlite3";
import { MemoryWorldStore, SOCIAL_ID_BASE, WorldCoreImpl, type SocialKind } from "@mmo-engine/world-server";
import { GuildBook } from "../src/guild.js";
import { SqliteGuildStore } from "../src/guild-store.js";
import { SqlitePartyStore } from "../src/party-store.js";
import { SqliteSocialStore } from "../src/social-store.js";
import { WorldTransportError } from "../src/world/client.js";
import { SocialWorldSync, type SocialWorldClient } from "../src/world/social-sync.js";

const API_KEY = "social-sync-key";

async function world(): Promise<WorldCoreImpl> {
  const core = new WorldCoreImpl({ store: new MemoryWorldStore(), heartbeatTimeoutMs: 60_000, heartbeatIntervalMs: 60_000, apiKeyHash: await argon2.hash(API_KEY) });
  for (const [regionId, x0] of [["a", 0], ["b", 100]] as const) {
    await core.registerRegion({ regionId, chunkRange: { x0, x1: x0 + 100, z0: 0, z1: 100 }, endpoint: "ws://x", capacity: 10, apiKey: API_KEY, opId: `reg-${regionId}` });
  }
  return core;
}

/** A region's client straight onto the core, errors as the webrpc transport would raise them. */
function clientFor(core: WorldCoreImpl, regionId: string): SocialWorldClient {
  const wrap = <T>(p: Promise<T>): Promise<T> => p.catch((e: { code?: number; message: string }) => { throw new WorldTransportError(e.code ?? 500, e.message); });
  return {
    putSocialRecord: (kind, key, doc, expectedVersion) => wrap(core.putSocialRecord(regionId, { regionId, kind, key, doc, expectedVersion, opId: randomUUID() })),
    getSocialRecords: (kind) => wrap(core.getSocialRecords(regionId, { regionId, kind })),
    allocateSocialIds: (kind, count) => wrap(core.allocateSocialIds(regionId, { regionId, kind, count, opId: randomUUID() })),
  };
}

function region(core: WorldCoreImpl, regionId: string) {
  const guilds = new SqliteGuildStore(new Database(":memory:"));
  const parties = new SqlitePartyStore(new Database(":memory:"));
  const social = new SqliteSocialStore(new Database(":memory:"));
  const reloaded: SocialKind[] = [];
  const logs: string[] = [];
  const sync = new SocialWorldSync({ client: clientFor(core, regionId), guilds, parties, social, reload: (k) => reloaded.push(k), log: (l) => logs.push(l) });
  return { guilds, parties, social, reloaded, logs, sync };
}

test("guilds, parties, friends and blocks: renumbered once, shared, edited, conflicted, and new ids from the world", async () => {
  const core = await world();
  const a = region(core, "a");
  const b = region(core, "b");

  // Region A from before fleet mode: its own guild 1 and party 1, a friends list, a block list.
  a.guilds.saveGuild({ id: 1, name: "Wolves", tag: "WLF", motd: "hi", members: [{ name: "Ana", rank: "leader", joinedAt: 5 }] });
  a.guilds.appendLog(1, 6, "Ana founded Wolves [WLF]");
  a.parties.saveParty({ id: 1, leader: "ana", members: [{ key: "ana", name: "Ana" }, { key: "bo", name: "Bo" }] });
  a.social.addFriend("ana", "Bo");
  a.social.addBlock("acct-a", "acct-spam", "Spammer");

  await a.sync.boot();
  const [wolves] = a.guilds.loadAll().guilds;
  assert.ok(wolves.id >= SOCIAL_ID_BASE, `renumbered onto a world id (got ${wolves.id})`);
  assert.equal(a.guilds.loadAll().guilds.length, 1, "the old local id is gone");
  assert.ok(a.parties.loadAll()[0].id >= SOCIAL_ID_BASE);
  assert.ok(a.logs.some((l) => l.includes("guild 1 renumbered")));

  // Region B has never seen any of it: its boot seeds it all.
  await b.sync.boot();
  assert.deepEqual(b.guilds.loadAll().guilds, a.guilds.loadAll().guilds);
  assert.deepEqual(b.guilds.loadAll().log.map((l) => l.text), ["Ana founded Wolves [WLF]"]);
  assert.deepEqual(b.parties.loadAll(), a.parties.loadAll());
  assert.deepEqual(b.social.loadFriends(), [{ owner: "ana", friend: "Bo" }]);
  assert.deepEqual(b.social.loadBlocks(), [{ blocker: "acct-a", target: "acct-spam", name: "Spammer" }]);

  // An edit on B through its book goes uphill and reaches A on A's next refresh.
  const bookB = new GuildBook(Date.now, b.sync.guildStore);
  assert.equal(bookB.setMotd("Ana", "raid at eight").ok, true);
  await b.sync.push();
  await a.sync.refresh();
  assert.equal(a.guilds.loadAll().guilds[0].motd, "raid at eight");
  assert.deepEqual(a.reloaded, ["guild"], "A's guild book is told to reload");

  // Both edit at once: B is first, A's write is refused (409), dropped, and A rereads B's.
  const bookA = new GuildBook(Date.now, a.sync.guildStore);
  bookB.setMotd("Ana", "from B");
  bookA.setMotd("Ana", "from A");
  await b.sync.push();
  await a.sync.push();
  assert.equal(a.guilds.loadAll().guilds[0].motd, "from B");
  assert.ok(a.logs.some((l) => l.includes("changed on another region first")));

  // A new guild founded on B takes a world id from the pool, never one A has.
  bookB.ids = () => b.sync.takeId("guild");
  assert.equal(bookB.create("Cy", "Ravens", "RVN").ok, true);
  const ravens = b.guilds.loadAll().guilds.find((g) => g.name === "Ravens")!;
  assert.ok(ravens.id >= SOCIAL_ID_BASE && ravens.id !== wolves.id);
  await b.sync.push();
  await a.sync.refresh();
  assert.ok(a.guilds.loadAll().guilds.some((g) => g.id === ravens.id && g.name === "Ravens"));

  // A friend removed on A is gone on B after the round trip.
  a.sync.socialStore.removeFriend("ana", "Bo");
  await a.sync.push();
  await b.sync.refresh();
  assert.deepEqual(b.social.loadFriends(), []);
});

test("an edit made while its record is uploading is sent on the next cycle, not lost", async () => {
  const core = await world();
  const a = region(core, "a");
  await a.sync.boot();
  const real = (a.sync as unknown as { opts: { client: SocialWorldClient } }).opts.client;
  let midUpload: (() => void) | null = () => a.sync.socialStore.addFriend("ana", "Cy");
  (a.sync as unknown as { opts: { client: SocialWorldClient } }).opts.client = {
    ...real,
    putSocialRecord: async (...args) => {
      midUpload?.();
      midUpload = null;
      return real.putSocialRecord(...args);
    },
  };
  a.sync.socialStore.addFriend("ana", "Bo");
  await a.sync.push();
  await a.sync.push();
  const [rec] = await core.getSocialRecords("a", { regionId: "a", kind: "friends" });
  assert.deepEqual(rec.doc, ["Bo", "Cy"]);
});
