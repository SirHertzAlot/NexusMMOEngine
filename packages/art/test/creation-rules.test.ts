/**
 * Character creation rules (roadmap EB7).
 *
 * The rules that matter here are the ones a game changes, so the tests
 * are mostly "a game sets X, and the server then refuses/accepts Y".
 * The first test is the one that protects everyone who has not written a
 * rules file: the defaults must still be what the engine did when these
 * choices were hardcoded in two places.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCatalog, type ModularCatalog } from "../src/character/modular-catalog.js";
import { APPEARANCE_COLOURS } from "../src/character/colour-slots.js";
import { validateLook, type CharacterLook } from "../src/character/look.js";
import {
  DEFAULT_CREATION_RULES,
  coloursForGender,
  creationColourSlots,
  creationLookProblems,
  creationRuleProblems,
  creationRulesDocument,
  creationSlots,
  parseCreationRules,
  partsForGender,
  type CreationRules,
} from "../src/character/creation-rules.js";

/** A catalog with the parts these tests name, built from the names themselves. */
const catalog: ModularCatalog = buildCatalog([
  "Chr_Head_Male_01",
  "Chr_Head_Female_01",
  "Chr_Hair_05",
  "Chr_Eyebrow_Male_01",
  "Chr_Eyebrow_Female_01",
  "Chr_FacialHair_Male_02",
  "Chr_Ear_Ear_01",
  "Chr_HelmetAttachment_01",
  "Chr_Torso_Male_01",
  "Chr_Torso_Male_05",
]).catalog;

const male = (parts: CharacterLook["parts"], colours: CharacterLook["colours"] = {}): CharacterLook => ({ gender: "male", parts, colours });
const fields = (problems: { field: string }[]): string[] => problems.map((p) => p.field).sort();

describe("the default creation rules", () => {
  it("are the five categories and five colours the engine had hardcoded", () => {
    assert.deepEqual([...creationSlots(DEFAULT_CREATION_RULES)], ["head", "hair", "eyebrows", "facialHair", "ears"]);
    assert.deepEqual([...creationColourSlots(DEFAULT_CREATION_RULES)].sort(), [...APPEARANCE_COLOURS].sort());
    assert.equal(DEFAULT_CREATION_RULES.lockBodyToStarter, true);
  });

  it("refuse exactly the ten armour attachments the old denylist spelled out", () => {
    const denied = ["headCovering", "helmet", "back", "shoulderRight", "shoulderLeft", "elbowRight", "elbowLeft", "hipsAttachment", "kneeRight", "kneeLeft"];
    for (const slot of denied) {
      const problems = creationLookProblems(catalog, male({ head: "Chr_Head_Male_01", [slot]: "Chr_HelmetAttachment_01" }));
      assert.deepEqual(fields(problems), [`parts.${slot}`], `${slot} should not be chosen at creation`);
    }
  });

  it("say nothing about a look a player could actually make", () => {
    const look = male({ head: "Chr_Head_Male_01", hair: "Chr_Hair_05", facialHair: "Chr_FacialHair_Male_02" }, { skin: "#8d5524", hair: "#1c1c1c" });
    assert.deepEqual(creationLookProblems(catalog, look), []);
    assert.deepEqual(validateLook(catalog, look), []);
  });

  it("lock the body to the starter armour", () => {
    assert.deepEqual(fields(creationLookProblems(catalog, male({ torso: "Chr_Torso_Male_05" }))), ["parts.torso"]);
    assert.deepEqual(creationLookProblems(catalog, male({ torso: "Chr_Torso_Male_01" })), [], "the starter set itself is fine");
  });

  it("keep a gendered category to its gender", () => {
    const female: CharacterLook = { gender: "female", parts: { head: "Chr_Head_Female_01", facialHair: "Chr_FacialHair_Male_02" }, colours: {} };
    assert.deepEqual(fields(creationLookProblems(catalog, female)), ["parts.facialHair"]);
    assert.match(creationLookProblems(catalog, female)[0].message, /male/);
    assert.deepEqual(fields(creationLookProblems(catalog, { ...female, parts: { head: "Chr_Head_Female_01" }, colours: { stubble: "#101010" } })), ["colours.stubble"]);
  });
});

describe("a game's own creation rules", () => {
  const noEars: CreationRules = { ...DEFAULT_CREATION_RULES, parts: DEFAULT_CREATION_RULES.parts.filter((p) => p.slot !== "ears") };

  it("refuse what the game stopped offering", () => {
    assert.deepEqual(creationLookProblems(catalog, male({ ears: "Chr_Ear_Ear_01" })), [], "ears are offered by default");
    assert.deepEqual(fields(creationLookProblems(catalog, male({ ears: "Chr_Ear_Ear_01" }), noEars)), ["parts.ears"]);
  });

  it("allow what the game opened up", () => {
    const helmets: CreationRules = { ...DEFAULT_CREATION_RULES, parts: [...DEFAULT_CREATION_RULES.parts, { slot: "helmet", optional: true }] };
    assert.deepEqual(creationLookProblems(catalog, male({ head: "Chr_Head_Male_01", helmet: "Chr_HelmetAttachment_01" }), helmets), []);
  });

  it("let a game unlock the body", () => {
    const free: CreationRules = { ...DEFAULT_CREATION_RULES, lockBodyToStarter: false };
    assert.deepEqual(creationLookProblems(catalog, male({ torso: "Chr_Torso_Male_05" }), free), []);
  });

  it("hold a game to its own gender list", () => {
    const oneGender: CreationRules = {
      ...DEFAULT_CREATION_RULES,
      genders: ["female"],
      parts: DEFAULT_CREATION_RULES.parts.filter((p) => p.gender !== "male"),
      colours: DEFAULT_CREATION_RULES.colours.filter((c) => c.gender !== "male"),
    };
    assert.deepEqual(fields(creationLookProblems(catalog, male({ head: "Chr_Head_Male_01" }), oneGender)), ["gender"]);
  });

  it("offer a gender only what is for it", () => {
    assert.deepEqual(partsForGender(DEFAULT_CREATION_RULES, "female").map((p) => p.slot), ["head", "hair", "eyebrows", "ears"]);
    assert.deepEqual(coloursForGender(DEFAULT_CREATION_RULES, "female").map((c) => c.slot), ["skin", "hair", "scar", "bodyArt"]);
    assert.equal(partsForGender(DEFAULT_CREATION_RULES, "male").length, 5);
  });
});

describe("reading a rules file", () => {
  it("fills everything the file leaves out", () => {
    const r = parseCreationRules({ lockBodyToStarter: false });
    assert.ok("rules" in r);
    assert.equal(r.rules.lockBodyToStarter, false);
    assert.deepEqual(r.rules.parts, DEFAULT_CREATION_RULES.parts, "a file about one flag does not have to restate the categories");
  });

  it("sends the character slot count back to the one file that owns it", () => {
    const r = parseCreationRules({ maxCharacters: 3 });
    assert.ok("problems" in r);
    assert.match(r.problems[0].message, /social\.json/);
  });

  it("treats no file as the defaults", () => {
    const r = parseCreationRules(undefined);
    assert.ok("rules" in r);
    assert.equal(r.rules, DEFAULT_CREATION_RULES);
  });

  it("refuses a document that would leave a character unmakeable", () => {
    for (const [doc, path] of [
      [{ parts: [] }, "parts"],
      [{ genders: [] }, "genders"],
      [{ parts: [{ slot: "head", optional: true }] }, "parts"],
      [{ parts: [{ slot: "head" }, { slot: "torso" }] }, "parts.1.slot"],
      [{ colours: [{ slot: "skin", swatches: [] }] }, "colours.0.swatches"],
      [{ colours: [{ slot: "skin", swatches: ["green"] }] }, "colours.0.swatches.0"],
      [{ parts: [{ slot: "head" }, { slot: "hair" }, { slot: "hair" }] }, "parts.2.slot"],
    ] as const) {
      const r = parseCreationRules(doc);
      assert.ok("problems" in r, `${JSON.stringify(doc)} should be refused`);
      assert.ok(r.problems.some((p) => p.path === path), `${JSON.stringify(doc)} → ${JSON.stringify(r.problems)}`);
    }
  });

  it("refuses a category offered to a gender the game does not have", () => {
    const r = parseCreationRules({ genders: ["female"], parts: [{ slot: "head" }, { slot: "facialHair", gender: "male" }] });
    assert.ok("problems" in r);
    assert.deepEqual(r.problems.map((p) => p.path), ["parts.1.gender", "colours.2.gender"], "the default male stubble row is caught too");
  });

  it("round-trips the defaults through the document form", () => {
    const r = parseCreationRules(creationRulesDocument());
    assert.ok("problems" in r === false);
    assert.deepEqual((r as { rules: CreationRules }).rules, DEFAULT_CREATION_RULES);
  });

  it("says what is wrong rather than throwing", () => {
    assert.deepEqual(parseCreationRules(7), { problems: [{ path: "", message: "character creation rules must be an object" }] });
    const r = parseCreationRules({ parts: "all of them" });
    assert.ok("problems" in r);
    assert.ok(r.problems.some((p) => p.path === "parts" && /list/.test(p.message)));
  });

  it("checks a hand-built rules object the same way", () => {
    assert.deepEqual(creationRuleProblems(DEFAULT_CREATION_RULES), []);
    assert.deepEqual(
      creationRuleProblems({ ...DEFAULT_CREATION_RULES, genders: ["elf" as "male"] }).map((p) => p.path),
      ["genders", "parts.3.gender", "colours.2.gender"],
    );
  });
});
