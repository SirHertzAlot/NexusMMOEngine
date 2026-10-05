/** FriendBook (roadmap S2b): add/remove, caps, case-insensitivity, watchers, schema. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FRIEND_LIMIT, FriendBook, FriendSchema, memoryFriendStore } from "../src/friends.js";
import { SqliteFriendStore } from "../src/friend-store.js";

describe("FriendBook", () => {
  it("adds, lists in order and removes case-insensitively", () => {
    const b = new FriendBook();
    assert.equal(b.add("Ann", "Bob"), "ok");
    assert.equal(b.add("Ann", "Cy"), "ok");
    assert.deepEqual(b.list("ann"), ["Bob", "Cy"]);
    assert.equal(b.add("Ann", "bob"), "exists");
    assert.ok(b.remove("ANN", "bOb"));
    assert.ok(!b.remove("Ann", "Bob"));
    assert.deepEqual(b.list("Ann"), ["Cy"]);
  });

  it("refuses yourself and caps the list", () => {
    const b = new FriendBook();
    assert.equal(b.add("Ann", "ann"), "self");
    for (let i = 0; i < FRIEND_LIMIT; i++) assert.equal(b.add("Ann", `f${i}`), "ok");
    assert.equal(b.add("Ann", "extra"), "full");
  });

  it("watchers are those who list the character, and lists are one-way", () => {
    const b = new FriendBook();
    b.add("Ann", "Bob");
    b.add("Cy", "bob");
    assert.deepEqual(b.watchers("Bob").sort(), ["ann", "cy"]);
    assert.deepEqual(b.watchers("Ann"), []);
    assert.deepEqual(b.list("Bob"), []);
  });

  it("schema is strict and trims", () => {
    assert.ok(FriendSchema.safeParse({ kind: "friend", name: " Bob ", on: true }).success);
    assert.ok(!FriendSchema.safeParse({ kind: "friend", name: "", on: true }).success);
    assert.ok(!FriendSchema.safeParse({ kind: "friend", name: "Bob", on: true, x: 1 }).success);
  });
});

describe("friend persistence", () => {
  it("a book reloads its lists from the store", () => {
    const store = memoryFriendStore();
    const a = new FriendBook(store);
    a.add("Ann", "Bob");
    a.add("Ann", "Cy");
    a.add("Dee", "Bob");
    a.remove("Ann", "bob");
    const b = new FriendBook(store);
    assert.deepEqual(b.list("ann"), ["Cy"]);
    assert.deepEqual(b.watchers("bob"), ["dee"]);
  });

  it("the SQLite store survives reopening the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friends-"));
    const file = path.join(dir, "friends.db");
    const stores: SqliteFriendStore[] = [];
    try {
      stores.push(new SqliteFriendStore(file));
      const a = new FriendBook(stores[0]);
      a.add("Ann", "Bob");
      a.add("Ann", "Cy");
      a.remove("Ann", "Bob");
      stores[0].close();
      stores.push(new SqliteFriendStore(file));
      const b = new FriendBook(stores[1]);
      assert.deepEqual(b.list("Ann"), ["Cy"]);
    } finally {
      for (const s of stores) s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
