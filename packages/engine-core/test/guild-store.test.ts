/** SqliteGuildStore (roadmap S4b): round-trip, cascade, log trimming, reopen from file. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GUILD_LOG_KEEP, GuildBook, type GuildRecord } from "../src/guild.js";
import { SqliteGuildStore } from "../src/guild-store.js";

function tmpDb(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guilds-"));
  return { file: path.join(dir, "guilds.db"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const owls: GuildRecord = {
  id: 1,
  name: "Night Owls",
  tag: "OWL",
  motd: "raid at 8",
  members: [
    { name: "Ann", rank: "leader", joinedAt: 10 },
    { name: "Bob", rank: "officer", joinedAt: 20 },
    { name: "Cy", rank: "recruit", joinedAt: 30 },
  ],
};

describe("SqliteGuildStore", () => {
  it("round-trips a guild with members in order, and updates in place", () => {
    const t = tmpDb();
    const s = new SqliteGuildStore(t.file);
    s.saveGuild(owls);
    assert.deepEqual(s.loadAll().guilds, [owls]);
    const next = { ...owls, motd: "new", members: owls.members.slice(0, 2) };
    s.saveGuild(next);
    assert.deepEqual(s.loadAll().guilds, [next]);
    s.close();
    t.done();
  });

  it("delete cascades members and log", () => {
    const t = tmpDb();
    const s = new SqliteGuildStore(t.file);
    s.saveGuild(owls);
    s.saveGuild({ ...owls, id: 2, name: "Other", tag: "OTH", members: [{ name: "Di", rank: "leader", joinedAt: 1 }] });
    s.appendLog(1, 5, "Ann made Bob officer");
    s.appendLog(2, 6, "kept");
    s.deleteGuild(1);
    const all = s.loadAll();
    assert.deepEqual(all.guilds.map((g) => g.id), [2]);
    assert.deepEqual(all.log, [{ guild: 2, at: 6, text: "kept" }]);
    s.close();
    t.done();
  });

  it("trims the log to the newest GUILD_LOG_KEEP lines per guild", () => {
    const t = tmpDb();
    const s = new SqliteGuildStore(t.file);
    s.saveGuild(owls);
    s.saveGuild({ ...owls, id: 2, name: "Other", tag: "OTH" });
    for (let i = 0; i < GUILD_LOG_KEEP + 25; i++) s.appendLog(1, i, `e${i}`);
    s.appendLog(2, 0, "solo");
    const log = s.loadAll().log;
    const mine = log.filter((l) => l.guild === 1);
    assert.equal(mine.length, GUILD_LOG_KEEP);
    assert.equal(mine[0]!.text, "e25");
    assert.equal(mine.at(-1)!.text, `e${GUILD_LOG_KEEP + 24}`);
    assert.equal(log.filter((l) => l.guild === 2).length, 1);
    s.close();
    t.done();
  });

  it("a GuildBook reopened from the file keeps guilds, ranks, MOTD and log", () => {
    const t = tmpDb();
    let now = 1000;
    const s1 = new SqliteGuildStore(t.file);
    const a = new GuildBook(() => now, s1);
    assert.ok(a.create("Ann", "Night Owls", "owl").ok);
    assert.ok(a.invite("Ann", "Bob").ok);
    assert.ok(a.accept("Bob").ok);
    assert.ok(a.setRank("Ann", "Bob", "officer").ok);
    assert.ok(a.setMotd("Ann", "hello").ok);
    s1.close();

    const s2 = new SqliteGuildStore(t.file);
    const b = new GuildBook(() => now, s2);
    assert.equal(b.guildName("Bob"), "Night Owls");
    assert.equal(b.rankOf("Bob"), "officer");
    assert.equal(b.rankOf("Ann"), "leader");
    assert.equal(b.motd("Ann"), "hello");
    assert.ok(b.logFor("Ann").length > 0);
    // Ids keep counting past the stored ones.
    assert.ok(b.create("Cy", "Second", "two").ok);
    assert.equal(b.guildName("Cy"), "Second");
    s2.close();
    t.done();
  });
});
