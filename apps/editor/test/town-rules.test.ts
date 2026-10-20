/**
 * Town rules forms (EG4): every field names a real key of the rules, and
 * every number a form section holds has a field (lists of buildings and
 * professions stay in the tree).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAt } from "../src/rules-control.js";
import { TOWN_FORMS } from "../src/town-rules.js";

const RULES = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/settlements/rules.json", import.meta.url)), "utf8")) as Record<string, unknown>;
/** Left to the tree: they are records of rows, not values. */
const TREE_ONLY = new Set(["mastery.professions"]);

const fieldsOf = (section: string) => TOWN_FORMS[section].flatMap((s) => s.fields);

/** Every leaf path under `v`; an array, or a key a field edits whole, is one leaf. */
function leaves(v: unknown, path: string, whole: Set<string>): string[] {
  if (whole.has(path) || v === null || typeof v !== "object" || Array.isArray(v)) return [path];
  return Object.entries(v).flatMap(([k, c]) => leaves(c, `${path}.${k}`, whole));
}

describe("town rules forms", () => {
  it("only name sections and keys the rules have (or may leave out)", () => {
    for (const section of Object.keys(TOWN_FORMS)) {
      assert.ok(section in RULES, section);
      for (const f of fieldsOf(section)) {
        const v = getAt(RULES, `${section}.${f.key}`);
        assert.ok(v !== undefined || f.def !== undefined || f.optional, `${section}.${f.key}`);
      }
    }
  });

  it("give every value of a form section a field", () => {
    for (const section of Object.keys(TOWN_FORMS)) {
      const keys = new Set(fieldsOf(section).map((f) => `${section}.${f.key}`));
      const missing = leaves(RULES[section], section, new Set([...keys, ...TREE_ONLY])).filter((p) => !keys.has(p) && !TREE_ONLY.has(p));
      assert.deepEqual(missing, [], section);
    }
  });

  it("keys are unique within a section", () => {
    for (const section of Object.keys(TOWN_FORMS)) {
      const keys = fieldsOf(section).map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, section);
    }
  });
});
