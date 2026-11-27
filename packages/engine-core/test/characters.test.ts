/**
 * Characters: the stores (SQLite and memory behave alike) and the rules
 * for a new character's name and look.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCatalog, DEFAULT_CREATION_RULES } from "@mmo-engine/art/character";
import {
  CHARACTER_NAME_RE,
  CharacterRefusedError,
  checkNewLook,
  loadCreationRules,
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

    it("saves and loads a character's state, the latest save winning", async () => {
      const { store, done } = make();
      try {
        const a = await store.create("alice", "Brienne", LOOK, 8);
        assert.equal(store.loadState?.(a.id), null, "never saved");
        store.saveState?.(a.id, { x: 1, y: 2, z: 3, health: 40, stamina: 7 });
        store.saveState?.(a.id, { x: 10, y: 2, z: -3, health: 55, stamina: 9 });
        assert.deepEqual(store.loadState?.(a.id), { x: 10, y: 2, z: -3, health: 55, stamina: 9 });
        assert.equal(store.loadState?.(a.id + 1), null, "per character");
      } finally {
        done();
      }
    });

    it("saves and loads a character's skills, the latest save winning", async () => {
      const { store, done } = make();
      try {
        const a = await store.create("alice", "Brienne", LOOK, 8);
        assert.equal(store.loadSkills?.(a.id), null, "never saved");
        store.saveSkills?.(a.id, { swimming: [100, 120, 5] });
        store.saveSkills?.(a.id, { swimming: [250, 250, 9], athletics: [10, 10, 9] });
        assert.deepEqual(store.loadSkills?.(a.id), { swimming: [250, 250, 9], athletics: [10, 10, 9] });
        assert.equal(store.loadSkills?.(a.id + 1), null, "per character");
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
    // Armour attachments are refused because the creation rules do not
    // offer those slots, so the wording is the rules' (EB7).
    assert.match(problems({ gender: "male", parts: { helmet: "Chr_HelmetAttachment_01" }, colours: {} }).join(), /not chosen at creation/);
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

/**
 * The creation rules file (roadmap EB7): the server reads what a player
 * may choose from `content/character-creation.json`, and behaves exactly
 * as it used to when there is no file.
 */
describe("character creation rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-creation-"));
  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, "utf8");
    return file;
  };
  const catalog = buildCatalog(["Chr_Head_Male_01", "Chr_Hair_05", "Chr_Ear_Ear_01", "Chr_HelmetAttachment_01"]).catalog;
  const look = (parts: Record<string, string>): unknown => ({ gender: "male", parts, colours: {} });

  it("is the engine's defaults when the game has no file", () => {
    const loaded = loadCreationRules(path.join(dir, "nothing-here.json"));
    assert.equal(loaded.from, null);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.rules, DEFAULT_CREATION_RULES);
  });

  it("reads a game's file and refuses what it stopped offering", () => {
    const file = write("no-ears.json", JSON.stringify({ parts: [{ slot: "head", optional: false }, { slot: "hair" }] }));
    const loaded = loadCreationRules(file);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.from, file);
    const refused = checkNewLook(catalog, look({ head: "Chr_Head_Male_01", ears: "Chr_Ear_Ear_01" }), loaded.rules);
    assert.ok("problems" in refused);
    assert.deepEqual(refused.problems, ["parts.ears: is not chosen at creation"]);
    assert.ok("json" in checkNewLook(catalog, look({ head: "Chr_Head_Male_01", hair: "Chr_Hair_05" }), loaded.rules));
  });

  it("accepts at creation what a game opens up", () => {
    const file = write("helmets.json", JSON.stringify({ parts: [{ slot: "head", optional: false }, { slot: "helmet" }] }));
    const { rules } = loadCreationRules(file);
    assert.ok("json" in checkNewLook(catalog, look({ head: "Chr_Head_Male_01", helmet: "Chr_HelmetAttachment_01" }), rules));
    assert.ok("problems" in checkNewLook(catalog, look({ head: "Chr_Head_Male_01", helmet: "Chr_HelmetAttachment_01" })), "and refuses it by default");
  });

  it("falls back to the defaults and says so when a file is wrong", () => {
    for (const body of ['{"parts": []}', "{not json"]) {
      const loaded = loadCreationRules(write("broken.json", body));
      assert.equal(loaded.rules, DEFAULT_CREATION_RULES);
      assert.ok(loaded.problems.length > 0, `${body} should be reported`);
      assert.ok(loaded.from !== null, "the file it could not use is named");
    }
  });

  it("checks the same look the same way with the defaults as before", () => {
    // The old behaviour, spelled out: a face is free, armour is not.
    assert.ok("json" in checkNewLook(catalog, look({ head: "Chr_Head_Male_01", hair: "Chr_Hair_05" })));
    const refused = checkNewLook(catalog, look({ head: "Chr_Head_Male_01", helmet: "Chr_HelmetAttachment_01" }));
    assert.ok("problems" in refused);
    assert.deepEqual(refused.problems, ["parts.helmet: is not chosen at creation"]);
  });
});
