/** PartyBook rules (roadmap S3): cap, leader powers, invite expiry, offline removal, disband. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INVITE_TTL_MS, OFFLINE_TTL_MS, PARTY_MAX, PartyBook, PartyOpSchema } from "../src/party.js";

function make(): { book: PartyBook; tick: (ms: number) => void } {
  let now = 0;
  return { book: new PartyBook(() => now), tick: (ms) => (now += ms) };
}

function form(book: PartyBook, leader: string, others: string[]): void {
  for (const o of others) {
    assert.ok(book.invite(leader, o).ok);
    assert.ok(book.accept(o).ok);
  }
}

describe("PartyBook", () => {
  it("an accepted invite forms a party led by the inviter", () => {
    const { book } = make();
    assert.ok(book.invite("Ann", "Bob").ok);
    assert.deepEqual(book.pendingInvite("bob"), { from: "Ann" });
    assert.ok(book.accept("Bob").ok);
    assert.deepEqual(book.members("Bob"), [
      { name: "Ann", leader: true, online: true },
      { name: "Bob", leader: false, online: true },
    ]);
  });

  it("only the leader invites, and the party caps at six", () => {
    const { book } = make();
    form(book, "A", ["B", "C", "D", "E", "F"]);
    assert.equal(book.partyOf("A").length, PARTY_MAX);
    assert.deepEqual(book.invite("B", "G"), { ok: false, reason: "only the leader can invite" });
    assert.deepEqual(book.invite("A", "G"), { ok: false, reason: "party is full" });
    assert.equal(book.invite("A", "A").ok, false);
  });

  it("an invite lapses after 60 s", () => {
    const { book, tick } = make();
    book.invite("A", "B");
    tick(INVITE_TTL_MS);
    assert.equal(book.pendingInvite("B"), null);
    assert.deepEqual(book.accept("B"), { ok: false, reason: "no invite" });
  });

  it("kick and promote are leader-only", () => {
    const { book } = make();
    form(book, "A", ["B", "C"]);
    assert.equal(book.kick("B", "C").ok, false);
    assert.equal(book.promote("B", "C").ok, false);
    assert.ok(book.promote("A", "B").ok);
    assert.equal(book.members("A").find((m) => m.leader)?.name, "B");
    assert.ok(book.kick("B", "C").ok);
    assert.deepEqual(book.partyOf("C"), []);
  });

  it("leader leaving hands over to the longest-standing; down to one disbands", () => {
    const { book } = make();
    form(book, "A", ["B", "C"]);
    book.leave("A");
    assert.equal(book.members("B").find((m) => m.leader)?.name, "B");
    book.leave("C");
    assert.deepEqual(book.partyOf("B"), []);
    assert.deepEqual(book.leave("B"), { ok: false, reason: "not in a party" });
  });

  it("a member offline for 5 minutes is removed; returning earlier keeps them", () => {
    const { book, tick } = make();
    form(book, "A", ["B", "C"]);
    book.setOnline("B", false);
    book.setOnline("C", false);
    tick(OFFLINE_TTL_MS - 1);
    book.setOnline("C", true);
    assert.deepEqual(book.sweep(), []);
    tick(1);
    assert.ok(book.sweep().length > 0);
    assert.deepEqual(book.partyOf("B"), []);
    assert.deepEqual(book.partyOf("A"), ["A", "C"]);
  });

  it("an offline leader passes leadership when removed", () => {
    const { book, tick } = make();
    form(book, "A", ["B", "C"]);
    book.setOnline("A", false);
    tick(OFFLINE_TTL_MS);
    book.sweep();
    assert.equal(book.members("B").find((m) => m.leader)?.name, "B");
  });

  it("the schema needs a name for invite, kick and promote only", () => {
    assert.ok(PartyOpSchema.safeParse({ kind: "party", op: "invite", name: "x" }).success);
    assert.ok(PartyOpSchema.safeParse({ kind: "party", op: "leave" }).success);
    assert.equal(PartyOpSchema.safeParse({ kind: "party", op: "invite" }).success, false);
    assert.equal(PartyOpSchema.safeParse({ kind: "party", op: "accept", name: "x" }).success, false);
  });
});
