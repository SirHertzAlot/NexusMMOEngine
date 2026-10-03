/** GuildBook rules (roadmap S4): create, invites, ranks, leadership succession, MOTD, log, persistence. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GUILD_INVITE_TTL_MS,
  GUILD_LOG_KEEP,
  GUILD_MOTD_MAX,
  GuildBook,
  GuildOpSchema,
  memoryGuildStore,
  type GuildStore,
} from "../src/guild.js";

function make(store?: GuildStore, max?: number): { book: GuildBook; tick: (ms: number) => void } {
  let now = 1000;
  return { book: new GuildBook(() => now, store, max), tick: (ms) => (now += ms) };
}

function join(book: GuildBook, from: string, who: string): void {
  assert.ok(book.invite(from, who).ok);
  assert.ok(book.accept(who).ok);
}

describe("GuildBook", () => {
  it("create makes a leader, validates name and tag, and keeps both unique", () => {
    const { book } = make();
    assert.ok(book.create("Ann", "Night Owls", "owl").ok);
    assert.equal(book.tagOf("ann"), "OWL");
    assert.equal(book.guildName("Ann"), "Night Owls");
    assert.equal(book.rankOf("Ann"), "leader");
    assert.equal(book.create("Ann", "Other", "OTH").ok, false, "one guild per character");
    assert.equal(book.create("Bob", "night owls", "NOW").ok, false, "name taken, case-insensitive");
    assert.equal(book.create("Bob", "Fresh", "owl").ok, false, "tag taken");
    assert.equal(book.create("Bob", "ab", "AB").ok, false, "name too short");
    assert.equal(book.create("Bob", "Fresh", "A").ok, false, "tag too short");
    assert.equal(book.create("Bob", "Fresh", "AB1").ok, false, "tag letters only");
    assert.equal(book.create("Bob", "<b>x</b>", "AB").ok, false, "name charset");
    assert.equal(book.tagOf("Bob"), "");
    assert.equal(book.guildName("Bob"), null);
  });

  it("an invite joins as recruit, expires after the TTL, and can't go to guilded characters", () => {
    const { book, tick } = make();
    book.create("Ann", "Owls", "OWL");
    book.create("Cy", "Crows", "CRW");
    assert.equal(book.invite("Ann", "Cy").ok, false, "already in a guild");
    assert.equal(book.invite("Ann", "ann").ok, false, "self");
    assert.ok(book.invite("Ann", "Bob").ok);
    assert.deepEqual(book.pendingInvite("bob"), { from: "Ann", guild: "Owls" });
    tick(GUILD_INVITE_TTL_MS);
    assert.equal(book.pendingInvite("Bob"), null);
    assert.deepEqual(book.accept("Bob"), { ok: false, reason: "no invite" });
    assert.ok(book.invite("Ann", "Bob").ok);
    const r = book.accept("Bob");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.notify.sort(), ["Ann", "Bob"]);
    assert.equal(book.rankOf("Bob"), "recruit");
    assert.equal(book.pendingInvite("Bob"), null);
  });

  it("sweep drops lapsed invites", () => {
    const { book, tick } = make();
    book.create("Ann", "Owls", "OWL");
    book.invite("Ann", "Bob");
    tick(GUILD_INVITE_TTL_MS + 1);
    book.sweep();
    assert.deepEqual(book.accept("Bob"), { ok: false, reason: "no invite" });
  });

  it("recruits and members can't invite; officers can", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    assert.equal(book.invite("Bob", "Cy").ok, false);
    assert.ok(book.setRank("Ann", "Bob", "member").ok);
    assert.equal(book.invite("Bob", "Cy").ok, false);
    assert.ok(book.setRank("Ann", "Bob", "officer").ok);
    assert.ok(book.invite("Bob", "Cy").ok);
    assert.equal(book.invite("Dee", "Cy").ok, false, "not in a guild");
  });

  it("the guild caps at its member limit", () => {
    const { book } = make(undefined, 2);
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    assert.deepEqual(book.invite("Ann", "Cy"), { ok: false, reason: "guild is full" });
  });

  it("rank rules: officers act below themselves, the leader hands over", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    for (const n of ["Bob", "Cy", "Dee"]) join(book, "Ann", n);
    assert.ok(book.setRank("Ann", "Bob", "officer").ok);
    assert.ok(book.setRank("Bob", "Cy", "member").ok);
    assert.equal(book.setRank("Bob", "Dee", "officer").ok, false, "not at own rank");
    assert.equal(book.setRank("Bob", "Ann", "member").ok, false, "not above");
    assert.equal(book.setRank("Bob", "Bob", "member").ok, false, "not self");
    assert.equal(book.setRank("Cy", "Dee", "member").ok, false, "members can't");
    assert.equal(book.setRank("Ann", "Cy", "member").ok, false, "no change");
    assert.equal(book.setRank("Bob", "Cy", "leader").ok, false, "officer can't hand over");
    assert.ok(book.setRank("Ann", "Bob", "leader").ok);
    assert.equal(book.rankOf("Bob"), "leader");
    assert.equal(book.rankOf("Ann"), "officer");
  });

  it("kick needs a higher rank, and the kicked are told", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    join(book, "Ann", "Cy");
    book.setRank("Ann", "Bob", "officer");
    assert.equal(book.kick("Cy", "Bob").ok, false);
    assert.equal(book.kick("Bob", "Ann").ok, false);
    assert.equal(book.kick("Bob", "Zed").ok, false);
    const r = book.kick("Bob", "Cy");
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.notify.includes("Cy"));
    assert.equal(book.guildName("Cy"), null);
    assert.equal(book.tagOf("Cy"), "");
  });

  it("when the leader leaves, the longest-standing top-ranked member takes over; an empty guild is deleted", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    for (const n of ["Bob", "Cy", "Dee"]) join(book, "Ann", n);
    book.setRank("Ann", "Cy", "officer");
    book.setRank("Ann", "Dee", "officer");
    assert.ok(book.leave("Ann").ok);
    assert.equal(book.rankOf("Cy"), "leader", "earliest-joined officer");
    assert.equal(book.rankOf("Dee"), "officer");
    assert.equal(book.rankOf("Bob"), "recruit");
    book.leave("Bob");
    book.leave("Cy");
    book.leave("Dee");
    assert.equal(book.guildName("Dee"), null);
    assert.ok(book.create("Eve", "Owls", "OWL").ok, "name and tag free again");
    assert.deepEqual(book.leave("Zed"), { ok: false, reason: "not in a guild" });
  });

  it("purge removes a deleted character like a leave", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    assert.deepEqual(book.purge("Ann").sort(), ["Ann", "Bob"]);
    assert.equal(book.rankOf("Bob"), "leader");
    assert.deepEqual(book.purge("Zed"), []);
  });

  it("MOTD is officer-only, trimmed and capped", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    assert.equal(book.setMotd("Bob", "hi").ok, false);
    assert.ok(book.setMotd("Ann", `  ${"x".repeat(GUILD_MOTD_MAX + 50)}  `).ok);
    assert.equal(book.motd("Bob").length, GUILD_MOTD_MAX);
    assert.ok(book.setMotd("Ann", "  raid at 8  ").ok);
    assert.equal(book.motd("Ann"), "raid at 8");
    assert.equal(book.motd("Zed"), "");
  });

  it("the log is for officers and above, and is capped", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    assert.deepEqual(book.logFor("Bob"), []);
    assert.ok(book.logFor("Ann").some((e) => e.text.includes("founded")));
    for (let i = 0; i < GUILD_LOG_KEEP + 20; i++) book.setMotd("Ann", `m${i}`);
    assert.equal(book.logFor("Ann").length, GUILD_LOG_KEEP);
  });

  it("members report online state", () => {
    const { book } = make();
    book.create("Ann", "Owls", "OWL");
    join(book, "Ann", "Bob");
    book.setOnline("ann", true);
    assert.deepEqual(book.members("Bob"), [
      { name: "Ann", rank: "leader", online: true },
      { name: "Bob", rank: "recruit", online: false },
    ]);
    book.setOnline("Ann", false);
    assert.equal(book.members("Bob")[0]?.online, false);
    assert.deepEqual(book.members("Zed"), []);
  });

  it("writes through to the store, and a new book reloads from it", () => {
    const store = memoryGuildStore();
    const a = make(store).book;
    a.create("Ann", "Owls", "OWL");
    join(a, "Ann", "Bob");
    a.setRank("Ann", "Bob", "officer");
    a.setMotd("Ann", "welcome");
    const b = make(store).book;
    assert.equal(b.guildName("Bob"), "Owls");
    assert.equal(b.rankOf("Bob"), "officer");
    assert.equal(b.motd("Ann"), "welcome");
    assert.ok(b.logFor("Ann").length > 0);
    assert.ok(b.create("Cy", "Crows", "CRW").ok, "ids continue past the loaded ones");
    b.leave("Cy");
    assert.equal(make(store).book.guildName("Cy"), null, "empty guild deleted from the store");
  });
});

describe("GuildOpSchema", () => {
  const ok = (m: unknown): boolean => GuildOpSchema.safeParse(m).success;
  it("accepts each op with exactly its fields", () => {
    assert.ok(ok({ kind: "guild", op: "create", name: "Owls", tag: "OWL" }));
    assert.ok(ok({ kind: "guild", op: "invite", name: "Bob" }));
    assert.ok(ok({ kind: "guild", op: "kick", name: "Bob" }));
    assert.ok(ok({ kind: "guild", op: "setRank", name: "Bob", rank: "officer" }));
    assert.ok(ok({ kind: "guild", op: "motd", text: "" }));
    assert.ok(ok({ kind: "guild", op: "accept" }));
    assert.ok(ok({ kind: "guild", op: "leave" }));
  });
  it("rejects missing, extra and oversized fields", () => {
    assert.equal(ok({ kind: "guild", op: "create", name: "Owls" }), false);
    assert.equal(ok({ kind: "guild", op: "invite", name: "Bob", tag: "X" }), false);
    assert.equal(ok({ kind: "guild", op: "setRank", name: "Bob", rank: "king" }), false);
    assert.equal(ok({ kind: "guild", op: "leave", name: "Bob" }), false);
    assert.equal(ok({ kind: "guild", op: "motd", text: "x".repeat(GUILD_MOTD_MAX + 1) }), false);
    assert.equal(ok({ kind: "guild", op: "accept", extra: 1 }), false);
  });
});
