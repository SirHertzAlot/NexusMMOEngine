/** FriendBook (roadmap S2b): add/remove, caps, case-insensitivity, watchers, schema. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FRIEND_LIMIT, FriendBook, FriendSchema } from "../src/friends.js";

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
