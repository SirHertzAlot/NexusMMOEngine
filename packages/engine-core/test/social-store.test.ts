/** SqliteSocialStore (roadmap S2c): friends and blocks round-trip and survive a reopen. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FriendBook } from "../src/friends.js";
import { BlockList } from "../src/chat.js";
import { memorySocialStore, SqliteSocialStore, type SocialStore } from "../src/social-store.js";

function tmpDb(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-"));
  return { file: path.join(dir, "social.db"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function roundTrip(open: () => SocialStore & { close?: () => void }): void {
  const s = open();
  s.addFriend("Ann", "Bob");
  s.addFriend("ann", "Cy");
  s.addFriend("ANN", "bob");
  s.addFriend("Di", "Ann");
  s.removeFriend("ann", "CY");
  s.addBlock("Acct-A", "Acct-B");
  s.addBlock("acct-a", "acct-b");
  s.addBlock("acct-a", "acct-c");
  s.removeBlock("ACCT-A", "acct-c");
  assert.deepEqual(s.loadFriends(), [
    { owner: "ann", friend: "Bob" },
    { owner: "di", friend: "Ann" },
  ]);
  assert.deepEqual(s.loadBlocks(), [{ blocker: "acct-a", target: "acct-b", name: "Acct-B" }]);
  s.close?.();
}

describe("SocialStore", () => {
  it("memory store dedupes case-insensitively and keeps add order", () => {
    roundTrip(memorySocialStore);
  });

  it("SQLite store matches the memory store", () => {
    const t = tmpDb();
    roundTrip(() => new SqliteSocialStore(t.file));
    t.done();
  });

  it("FriendBook and BlockList come back from the file after a restart", () => {
    const t = tmpDb();
    let s = new SqliteSocialStore(t.file);
    const friends = new FriendBook(s);
    const blocks = new BlockList(s);
    friends.add("Ann", "Bob");
    friends.add("Ann", "Cy");
    friends.add("Ann", "Di");
    friends.remove("Ann", "cy");
    assert.ok(blocks.add("acct-a", "Acct-B"));
    assert.ok(blocks.add("acct-a", "acct-c"));
    blocks.remove("acct-a", "ACCT-C");
    s.close();

    s = new SqliteSocialStore(t.file);
    const f2 = new FriendBook(s);
    const b2 = new BlockList(s);
    assert.deepEqual(f2.list("ann"), ["Bob", "Di"]);
    assert.deepEqual(f2.watchers("bob"), ["ann"]);
    assert.equal(f2.add("Ann", "BOB"), "exists");
    assert.ok(b2.isBlocked("ACCT-A", "acct-b"));
    assert.ok(!b2.isBlocked("acct-a", "acct-c"));
    s.close();
    t.done();
  });

  it("block names come back for the block list (U8)", () => {
    const t = tmpDb();
    let s = new SqliteSocialStore(t.file);
    const blocks = new BlockList(s);
    blocks.add("acct-a", "acct-b", "Borin");
    blocks.add("acct-a", "acct-c", "Cyra");
    assert.deepEqual(blocks.names("ACCT-A"), ["Borin", "Cyra"]);
    s.close();
    s = new SqliteSocialStore(t.file);
    const b2 = new BlockList(s);
    assert.deepEqual(b2.names("acct-a"), ["Borin", "Cyra"]);
    assert.equal(b2.accountNamed("acct-a", "borin"), "acct-b");
    assert.equal(b2.accountNamed("acct-a", "nobody"), undefined);
    b2.remove("acct-a", b2.accountNamed("acct-a", "CYRA")!);
    assert.deepEqual(b2.names("acct-a"), ["Borin"]);
    s.close();
    t.done();
  });

  it("a social.db from before block names opens and lists accounts", async () => {
    const t = tmpDb();
    const { default: Database } = await import("better-sqlite3");
    const old = new Database(t.file);
    old.exec("CREATE TABLE blocks (blocker TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (blocker, target)); INSERT INTO blocks VALUES ('acct-a', 'acct-b');");
    old.close();
    const s = new SqliteSocialStore(t.file);
    const blocks = new BlockList(s);
    assert.deepEqual(blocks.names("acct-a"), ["acct-b"]);
    blocks.add("acct-a", "acct-c", "Cyra");
    assert.deepEqual(s.loadBlocks().map((r) => r.name), ["acct-b", "Cyra"]);
    s.close();
    t.done();
  });

  it("refused adds write nothing", () => {
    const s = memorySocialStore();
    const friends = new FriendBook(s);
    const blocks = new BlockList(s);
    assert.equal(friends.add("Ann", "ann"), "self");
    assert.ok(!blocks.add("acct-a", "ACCT-A"));
    assert.ok(!friends.remove("Ann", "nobody"));
    assert.deepEqual(s.loadFriends(), []);
    assert.deepEqual(s.loadBlocks(), []);
  });
});
