/**
 * Characters: the stores (SQLite and memory behave alike) and the rules
 * for a new character's name and look.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCatalog } from "@mmo-engine/art/character";
import {
  CHARACTER_NAME_RE,
  CharacterRefusedError,
  checkNewLook,
  MemoryCharacterStore,
  SqliteCharacterStore,
  type CharacterStore,
} from "../src/index.js";

const LOOK = '{"gender":"male","parts":{},"colours":{}}';

function stores(): Array<[string, () => { store: CharacterStore; done(): void }]> {
  return [
    ["memory", () => ({ store: new MemoryCharacterStore(() => 5), done() {} })],
    [
      "sqlite",
      () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-chars-"));
        const store = new SqliteCharacterStore(path.join(dir, "characters.db"), () => 5);
        return {
          store,
          done() {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
          },
        };
      },
    ],
  ];
}

for (const [kind, make] of stores()) {
  describe(`${kind} character store`, () => {
    it("creates, lists per account, and gets only the owner's", async () => {
      const { store, done } = make();
      try {
        const a = await store.create("alice", "Brienne", LOOK, 8);
        const b = await store.create("alice", "Tormund", LOOK, 8);
        await store.create("bob", "Gilly", LOOK, 8);
        assert.deepEqual(a, { id: a.id, username: "alice", name: "Brienne", look: LOOK, createdAt: 5 });
        assert.deepEqual((await store.list("alice")).map((c) => c.name), ["Brienne", "Tormund"]);
        assert.deepEqual(await store.get("alice", b.id), b);
        assert.equal(await store.get("bob", a.id), null, "someone else's character");
        assert.equal(await store.get("alice", 999), null);
        assert.deepEqual(await store.list("nobody"), []);
      } finally {
        done();
      }
    });

    it("refuses a taken name (any case) and a full account", async () => {
      const { store, done } = make();
      try {
        await store.create("alice", "Brienne", LOOK, 2);
        await assert.rejects(store.create("bob", "bRIENNE", LOOK, 2), (e) => e instanceof CharacterRefusedError && e.reason === "name-taken");
        await store.create("alice", "Podrick", LOOK, 2);
        await assert.rejects(store.create("alice", "Jaime", LOOK, 2), (e) => e instanceof CharacterRefusedError && e.reason === "limit");
        assert.equal((await store.list("alice")).length, 2);
      } finally {
        done();
      }
    });
  });
}

describe("new character rules", () => {
  it("names: 3-16 letters, apostrophes and hyphens, starting with a letter", () => {
    for (const ok of ["Ann", "D'Artagnan", "Mary-Jane", "abcdefghijklmnop"]) assert.ok(CHARACTER_NAME_RE.test(ok), ok);
    for (const bad of ["Al", "-Ann", "Ann Lee", "Ann1", "abcdefghijklmnopq", "Zoë", ""]) assert.ok(!CHARACTER_NAME_RE.test(bad), bad);
  });

  it("a look gets its canonical JSON; the body is the starter armour", () => {
    const ok = checkNewLook(null, {
      gender: "female",
      parts: { hair: "Chr_Hair_03", head: "Chr_Head_Female_02", torso: "Chr_Torso_Female_01" },
      colours: { skin: "#8D5524" },
    });
    assert.ok("json" in ok);
    assert.equal(ok.json, '{"gender":"female","parts":{"torso":"Chr_Torso_Female_01","head":"Chr_Head_Female_02","hair":"Chr_Hair_03"},"colours":{"skin":"#8d5524"}}');

    const problems = (raw: unknown): string[] => {
      const r = checkNewLook(null, raw);
      return "problems" in r ? r.problems : [];
    };
    assert.match(problems({ gender: "male", parts: { torso: "Chr_Torso_Male_07" }, colours: {} }).join(), /starter armour/);
    assert.match(problems({ gender: "male", parts: { head: "Chr_Head_Female_02" }, colours: {} }).join(), /female characters/);
    assert.match(problems({ gender: "male", parts: { helmet: "Chr_HelmetAttachment_01" }, colours: {} }).join(), /attachments/);
    assert.match(problems({ gender: "male", parts: {}, colours: { primary: "#ffffff" } }).join(), /not chosen at creation/);
    assert.match(problems({ gender: "male", parts: { head: "Chr_Wings_01" }, colours: {} }).join(), /not a part/);
    assert.deepEqual(problems("nonsense"), ["look: not a look"]);
  });

  it("with the pack's catalog, a part must exist", () => {
    const { catalog } = buildCatalog(["Chr_Head_Male_01", "Chr_Torso_Male_01"]);
    assert.ok("json" in checkNewLook(catalog, { gender: "male", parts: { head: "Chr_Head_Male_01" }, colours: {} }));
    const r = checkNewLook(catalog, { gender: "male", parts: { head: "Chr_Head_Male_09" }, colours: {} });
    assert.ok("problems" in r && /not a part/.test(r.problems.join()));
  });
});
