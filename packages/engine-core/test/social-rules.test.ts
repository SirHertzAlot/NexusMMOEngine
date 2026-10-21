/** Social limits from content/rules/social.json (EG9): party, guild and block limits follow the rules, defaults unchanged. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SocialSchema } from "@mmo-engine/rules";
import { PARTY_MAX, INVITE_TTL_MS, OFFLINE_TTL_MS, PartyBook } from "../src/party.js";
import { GUILD_INVITE_TTL_MS, GUILD_LOG_KEEP, GUILD_MAX, GUILD_MOTD_MAX, GuildBook } from "../src/guild.js";
import { BLOCK_LIMIT, BlockList, CHAT_COOLDOWN_MS, SAY_RANGE_M } from "../src/chat.js";
import { DEFAULT_MAX_CHARACTERS } from "../src/characters/index.js";

const social = (over: object = {}) => SocialSchema.parse(over);

describe("social rules (EG9)", () => {
  it("the schema's defaults are the old constants", () => {
    const d = social();
    assert.equal(d.party.max, PARTY_MAX);
    assert.equal(d.party.inviteSeconds * 1000, INVITE_TTL_MS);
    assert.equal(d.party.offlineMinutes * 60_000, OFFLINE_TTL_MS);
    assert.equal(d.guild.max, GUILD_MAX);
    assert.equal(d.guild.inviteSeconds * 1000, GUILD_INVITE_TTL_MS);
    assert.equal(d.guild.motdMax, GUILD_MOTD_MAX);
    assert.equal(d.guild.logKeep, GUILD_LOG_KEEP);
    assert.equal(d.chat.sayRangeM, SAY_RANGE_M);
    assert.equal(d.chat.blockLimit, BLOCK_LIMIT);
    for (const [k, ms] of Object.entries(CHAT_COOLDOWN_MS)) assert.equal(d.chat.cooldownSeconds[k as keyof typeof CHAT_COOLDOWN_MS] * 1000, ms, k);
    assert.equal(d.characters.slots, DEFAULT_MAX_CHARACTERS);
  });

  it("refuses a chat line longer than the client can send", () => {
    assert.equal(SocialSchema.safeParse({ chat: { textMax: 501 } }).success, false);
    assert.equal(SocialSchema.safeParse({ party: { max: 1 } }).success, false);
  });

  it("a party follows its size and timeouts", () => {
    let now = 0;
    const book = new PartyBook(() => now);
    book.setRules(social({ party: { max: 3, inviteSeconds: 10, offlineMinutes: 1 } }).party);
    for (const o of ["B", "C"]) {
      assert.ok(book.invite("A", o).ok);
      assert.ok(book.accept(o).ok);
    }
    assert.deepEqual(book.invite("A", "D"), { ok: false, reason: "party is full" });
    book.leave("C");
    assert.ok(book.invite("A", "D").ok);
    now += 10_000;
    assert.equal(book.accept("D").ok, false, "the invite lapsed after 10 s");
    book.setOnline("B", false);
    now += 60_000;
    book.sweep();
    assert.deepEqual(book.partyOf("A"), [], "B left after a minute offline, and a party of one disbands");
  });

  it("a guild follows its size, invite timeout, message length and log length", () => {
    let now = 0;
    const book = new GuildBook(() => now);
    book.setRules(social({ guild: { max: 2, inviteSeconds: 5, motdMax: 10, logKeep: 2 } }).guild);
    assert.ok(book.create("Ann", "Wardens", "WRD").ok);
    assert.ok(book.invite("Ann", "Bob").ok);
    now += 5_000;
    assert.equal(book.accept("Bob").ok, false, "the invite lapsed after 5 s");
    assert.ok(book.invite("Ann", "Bob").ok);
    assert.ok(book.accept("Bob").ok);
    assert.deepEqual(book.invite("Ann", "Cid"), { ok: false, reason: "guild is full" });
    assert.ok(book.setMotd("Ann", "Raid at dusk, bring torches").ok);
    assert.equal(book.motd("Ann"), "Raid at du");
    assert.equal(book.logFor("Ann").length, 2);
  });

  it("the block list stops at its limit", () => {
    const blocks = new BlockList();
    blocks.limit = 1;
    assert.ok(blocks.add("ann", "bob"));
    assert.equal(blocks.add("ann", "cid"), false);
  });
});
