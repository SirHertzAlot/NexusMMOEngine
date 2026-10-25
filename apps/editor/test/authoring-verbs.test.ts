import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_VERBS, VerbHistory, makeVerbCall, validateVerbCall, verbByName, type Provenance } from "../src/authoring/index.js";

const mara: Provenance = {
  who: { id: "joey", role: "designer" },
  what: "Blacksmith Mara",
  when: 1_800_000_000_000,
  where: "Haven / Market Square / Blacksmith Mara",
  why: "vendor stock",
};

describe("verb registry (audit §4)", () => {
  it("registers exactly the 13 canonical verbs, each with a home and a signature", () => {
    assert.equal(CANONICAL_VERBS.length, 13);
    for (const v of CANONICAL_VERBS) {
      assert.ok(v.home.length > 0, v.name);
      assert.ok(v.signature.length > 0, v.name);
    }
    assert.deepEqual(
      CANONICAL_VERBS.map((v) => v.name),
      ["giveItem", "giveGold", "takeItem", "defOf", "moveItem", "countBase", "resolveBase", "spawnCreature", "teleport", "startDialogue", "attachVendor", "placeItemFixture", "grantQuestReward"],
    );
  });

  it("resolves the paired-row aliases to their canonical verb", () => {
    assert.equal(verbByName("detachVendor")?.name, "attachVendor");
    assert.equal(verbByName("spawnPack")?.name, "spawnCreature");
    assert.equal(verbByName("explodeEverything"), undefined);
  });
});

describe("5W1H envelope", () => {
  it("accepts a fully-attributed call", () => {
    assert.deepEqual(validateVerbCall({ verb: "giveItem", params: { character: "p1", def: "sword" }, provenance: mara }), []);
  });

  it("rejects anonymous verb calls — no actor id, no role, no intent", () => {
    const noId = validateVerbCall({ verb: "giveItem", params: {}, provenance: { ...mara, who: { id: "", role: "designer" } } });
    assert.ok(noId.some((p) => p.includes("anonymous")), noId.join("; "));
    const noRole = validateVerbCall({ verb: "giveItem", params: {}, provenance: { ...mara, who: { id: "x", role: "nobody" as never } } });
    assert.ok(noRole.some((p) => p.includes("anonymous")), noRole.join("; "));
    const noWhy = validateVerbCall({ verb: "giveItem", params: {}, provenance: { ...mara, why: "  " } });
    assert.ok(noWhy.some((p) => p.includes("why")), noWhy.join("; "));
  });

  it("rejects non-canonical verbs", () => {
    assert.ok(validateVerbCall({ verb: "hackTheWorld", params: {}, provenance: mara }).some((p) => p.includes("13 canonical")));
  });

  it("makeVerbCall throws instead of building an anonymous call", () => {
    assert.throws(() => makeVerbCall("giveItem", {}, { ...mara, who: { id: "", role: "designer" } }), /anonymous/);
  });
});

describe("VerbHistory", () => {
  it("is append-only in effect: queries return the recorded calls per object and per actor", () => {
    const history = new VerbHistory();
    history.append(makeVerbCall("attachVendor", { entity: "npc-mara", templateId: "weapons-tier2" }, mara));
    history.append(makeVerbCall("giveItem", { character: "p1", def: "sword" }, { ...mara, who: { id: "sam", role: "developer" }, why: "quest reward" }));
    assert.equal(history.all().length, 2);
    assert.equal(history.forObject("Haven / Market Square / Blacksmith Mara").length, 2);
    assert.equal(history.forObject("Blacksmith Mara").length, 2);
    assert.equal(history.forActor("joey").length, 1);
    assert.equal(history.forActor("sam").length, 1);
    assert.equal(history.forActor("nobody").length, 0);
  });

  it("refuses to record an anonymous call", () => {
    const history = new VerbHistory();
    assert.throws(() => history.append({ verb: "giveItem", params: {}, provenance: { ...mara, why: "" } }), /why/);
    assert.equal(history.all().length, 0);
  });
});
