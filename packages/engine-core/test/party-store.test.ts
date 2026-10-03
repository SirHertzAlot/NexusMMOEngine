/** SqlitePartyStore (roadmap S3b): parties come back after a restart, offline, and lapse if nobody returns. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OFFLINE_TTL_MS, PartyBook } from "../src/party.js";
import { SqlitePartyStore } from "../src/party-store.js";

function tmpDb(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parties-"));
  return { file: path.join(dir, "parties.db"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function form(book: PartyBook, leader: string, others: string[]): void {
  for (const o of others) {
    assert.ok(book.invite(leader, o).ok);
    assert.ok(book.accept(o).ok);
  }
}

describe("SqlitePartyStore", () => {
  it("round-trips members in join order, leader and display names", () => {
    const t = tmpDb();
    const s = new SqlitePartyStore(t.file);
    s.saveParty({ id: 3, leader: "bob", members: [{ key: "ann", name: "Ann" }, { key: "bob", name: "Bob" }] });
    s.saveParty({ id: 3, leader: "ann", members: [{ key: "ann", name: "Ann" }] });
    s.saveParty({ id: 4, leader: "cy", members: [{ key: "cy", name: "Cy" }, { key: "di", name: "Di" }] });
    s.deleteParty(4);
    assert.deepEqual(s.loadAll(), [{ id: 3, leader: "ann", members: [{ key: "ann", name: "Ann" }] }]);
    s.close();
    t.done();
  });

  it("a party survives a restart with everyone offline until they log in", () => {
    const t = tmpDb();
    let now = 1000;
    let s = new SqlitePartyStore(t.file);
    let book = new PartyBook(() => now, s);
    form(book, "Ann", ["Bob", "Cy"]);
    assert.ok(book.promote("Ann", "Bob").ok);
    form(book, "Di", ["Ed"]);
    assert.ok(book.leave("Ed").ok); // disbands Di's party
    s.close();

    s = new SqlitePartyStore(t.file);
    book = new PartyBook(() => now, s);
    assert.deepEqual(book.members("cy"), [
      { name: "Ann", leader: false, online: false },
      { name: "Bob", leader: true, online: false },
      { name: "Cy", leader: false, online: false },
    ]);
    assert.deepEqual(book.partyOf("Di"), []);
    book.setOnline("Bob", true);
    book.setOnline("Cy", true);
    // New parties don't reuse a live id.
    form(book, "Di", ["Ed"]);
    assert.deepEqual(book.partyOf("Ed"), ["Di", "Ed"]);
    assert.deepEqual(book.partyOf("Ann"), ["Ann", "Bob", "Cy"]);
    now += OFFLINE_TTL_MS;
    book.sweep();
    assert.deepEqual(book.partyOf("Bob"), ["Bob", "Cy"]);
    s.close();

    s = new SqlitePartyStore(t.file);
    book = new PartyBook(() => now, s);
    assert.deepEqual(book.partyOf("bob"), ["Bob", "Cy"]);
    assert.deepEqual(book.partyOf("ed"), ["Di", "Ed"]);
    s.close();
    t.done();
  });
});
