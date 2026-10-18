/**
 * The gameplay tables' pure helpers (ED1): key-path edits that clear back
 * to the engine default, field text parsing, and issue filtering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREATURE_FIELDS,
  DEATH_FIELDS,
  LOOT_FIELDS,
  fieldText,
  getAt,
  isFieldError,
  issuesAt,
  parseField,
  setAt,
  type FieldSpec,
} from "../src/rules-control.js";

const spec = (fields: FieldSpec[], key: string): FieldSpec => fields.find((f) => f.key === key)!;

describe("getAt / setAt", () => {
  it("reads and writes nested keys without touching the original", () => {
    const death = { respawn: { delaySeconds: 10 }, recordDeaths: true };
    const next = setAt(death, "respawn.at", "spawn");
    assert.deepEqual(next, { respawn: { delaySeconds: 10, at: "spawn" }, recordDeaths: true });
    assert.deepEqual(death, { respawn: { delaySeconds: 10 }, recordDeaths: true });
    assert.equal(getAt(next, "respawn.at"), "spawn");
    assert.equal(getAt(next, "keep.items"), undefined);
  });

  it("undefined removes the key, so the engine default applies", () => {
    assert.deepEqual(setAt({ a: 1, b: 2 }, "a", undefined), { b: 2 });
    assert.deepEqual(setAt({}, "keep.skills", false), { keep: { skills: false } });
  });
});

describe("parseField / fieldText", () => {
  it("numbers, and an empty input clears", () => {
    const f = spec(LOOT_FIELDS, "pickupRange");
    assert.equal(parseField(f, " 3.5 "), 3.5);
    assert.equal(parseField(f, ""), undefined);
    assert.ok(isFieldError(parseField(f, "far")));
  });

  it("pairs round-trip", () => {
    const f = spec(CREATURE_FIELDS, "pack");
    assert.deepEqual(parseField(f, "2–4"), [2, 4]);
    assert.deepEqual(parseField(f, "2-4"), [2, 4]);
    assert.equal(fieldText(f, [2, 4]), "2–4");
    assert.ok(isFieldError(parseField(f, "2")));
    assert.ok(isFieldError(parseField(f, "1.5-3")));
  });

  it("a nullable field stores null when emptied, and shows it empty", () => {
    const f: FieldSpec = { key: "rank", label: "Rank", kind: "number", int: true, nullable: true };
    assert.equal(parseField(f, ""), null);
    assert.equal(parseField(f, "2"), 2);
    assert.equal(fieldText(f, null), "");
  });

  it("lists and bools", () => {
    assert.deepEqual(parseField(spec(CREATURE_FIELDS, "weapons"), "dagger, axe,,"), ["dagger", "axe"]);
    assert.equal(fieldText(spec(CREATURE_FIELDS, "weapons"), ["dagger", "axe"]), "dagger, axe");
    assert.equal(parseField(spec(DEATH_FIELDS, "keep.skills"), "false"), false);
  });
});

describe("issuesAt", () => {
  const issues = [
    { file: "creatures.json", path: "creatures.goblin.weapons[0]", message: "unknown" },
    { file: "creatures.json", path: "creatures.goblin2.health", message: "x" },
    { file: "loot.json", path: "pickupRange", message: "too small" },
  ];
  it("matches the path and what's below it, in that file only", () => {
    assert.equal(issuesAt(issues, "creatures", "creatures.goblin").length, 1);
    assert.equal(issuesAt(issues, "creatures", "creatures.goblin.weapons").length, 1);
    assert.equal(issuesAt(issues, "loot", "pickupRange").length, 1);
    assert.equal(issuesAt(issues, "items", "pickupRange").length, 0);
  });
});
