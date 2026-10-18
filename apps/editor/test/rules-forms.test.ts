/**
 * Combat and body as forms (EG2): the field specs reach every value of
 * combat.json and body.json, the store edits both and lists the skills a
 * technique can name, and the form helpers handle maps, lists of parts and
 * the rules package's bracketed issue paths.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { engineDefaults } from "@mmo-engine/rules";
import {
  BODY_PART_FIELDS,
  BODY_SECTIONS,
  COMBAT_SECTIONS,
  CREATURE_AI_SECTIONS,
  MOVEMENT_SECTIONS,
  TECHNIQUE_FIELDS,
  fieldText,
  getAt,
  isFieldError,
  issuesAt,
  parseField,
  setAt,
  type FieldSpec,
} from "../src/rules-control.js";
import { readRulesTables, saveRulesTable } from "../src/rules-store.js";

const RULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../content/rules");

/** Every leaf key path of a defaults object; `stopAt` paths count as one leaf (maps, records, lists). */
function leaves(obj: unknown, stopAt: readonly string[], prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || stopAt.includes(prefix)) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leaves(v, stopAt, prefix ? `${prefix}.${k}` : k));
}
const keysOf = (sections: ReadonlyArray<{ fields: FieldSpec[] }>): string[] => sections.flatMap((s) => s.fields.map((f) => f.key)).sort();

describe("combat and body forms cover their files", () => {
  it("combat: every coefficient, techniques as records", () => {
    const want = leaves(engineDefaults().combat, ["techniques"]).filter((k) => k !== "techniques").sort();
    assert.deepEqual(keysOf(COMBAT_SECTIONS), want);
    assert.deepEqual(TECHNIQUE_FIELDS.map((f) => f.key).sort(), ["damageKind", "property", "skill"]);
  });

  it("body: every value beside the parts, and every part field but its id", () => {
    const want = leaves(engineDefaults().body, ["parts", "fall.parts"]).filter((k) => k !== "parts").sort();
    assert.deepEqual(keysOf(BODY_SECTIONS), want);
    assert.deepEqual(BODY_PART_FIELDS.map((f) => f.key).sort(), ["atZero", "hitMultiplier", "holds", "name", "parent", "share", "slot"]);
  });

  it("creature brains (EG7): every ai value, defaults as placeholders", () => {
    const d = engineDefaults().creatures;
    assert.deepEqual(keysOf(CREATURE_AI_SECTIONS), leaves(d.ai, [], "ai").sort());
    for (const f of CREATURE_AI_SECTIONS.flatMap((s) => s.fields)) assert.equal(f.def, getAt(d, f.key), f.key);
  });

  it("movement (EG5): every value, with the engine default as its placeholder", () => {
    const d = engineDefaults().movement;
    assert.deepEqual(keysOf(MOVEMENT_SECTIONS), leaves(d, []).sort());
    for (const f of MOVEMENT_SECTIONS.flatMap((s) => s.fields)) assert.equal(f.def, getAt(d, f.key), f.key);
  });
});

describe("form helpers", () => {
  const map: FieldSpec = { key: "fall.parts", label: "Parts", kind: "map" };

  it("maps round-trip as `id: number` pairs", () => {
    assert.deepEqual(parseField(map, "legLeft: 0.35, hips:0.15"), { legLeft: 0.35, hips: 0.15 });
    assert.equal(fieldText(map, { legLeft: 0.35, hips: 0.15 }), "legLeft: 0.35, hips: 0.15");
    assert.ok(isFieldError(parseField(map, "legLeft 0.35")));
    assert.ok(isFieldError(parseField(map, "legLeft: lots")));
    assert.equal(parseField(map, ""), undefined);
  });

  it("setAt keeps a list a list", () => {
    const doc = { parts: [{ id: "torso", share: 0.5 }, { id: "head", share: 0.5 }] };
    const next = setAt(doc, "parts.1.share", 0.25) as typeof doc;
    assert.ok(Array.isArray(next.parts));
    assert.equal(getAt(next, "parts.1.share"), 0.25);
    assert.equal(doc.parts[1].share, 0.5);
  });

  it("issuesAt reads the rules package's bracketed paths", () => {
    const issues = [{ file: "body.json", path: "parts[1].parent", message: 'no part "neck"' }];
    assert.equal(issuesAt(issues, "body", "parts.1.parent").length, 1);
    assert.equal(issuesAt(issues, "body", "parts.1").length, 1);
    assert.equal(issuesAt(issues, "body", "parts.10").length, 0);
  });
});

describe("rules store: combat and body", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eg2-rules-"));
    for (const f of fs.readdirSync(RULES)) if (f.endsWith(".json")) fs.copyFileSync(path.join(RULES, f), path.join(dir, f));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

  it("reads both tables and the skill ids", () => {
    const snap = readRulesTables(dir);
    assert.deepEqual(snap.tables.combat, read("combat"));
    assert.deepEqual(snap.tables.body, read("body"));
    assert.ok(snap.skills.includes("medicine"));
  });

  it("saves a combat coefficient and refuses a bad one", () => {
    const combat = read("combat");
    assert.deepEqual(saveRulesTable(dir, "combat", setAt(combat, "defence.base", 0.6)), { ok: true });
    assert.equal(getAt(read("combat"), "defence.base"), 0.6);
    const res = saveRulesTable(dir, "combat", setAt(combat, "defence.max", 2));
    assert.ok(!res.ok && res.issues.some((i) => i.file === "combat.json" && i.path === "defence.max"));
  });

  it("refuses a body part hanging from a part that doesn't exist, writing nothing", () => {
    const before = fs.readFileSync(path.join(dir, "body.json"), "utf8");
    const res = saveRulesTable(dir, "body", setAt(read("body"), "parts.1.parent", "neck"));
    assert.ok(!res.ok && issuesAt(res.issues, "body", "parts.1.parent").length > 0);
    assert.equal(fs.readFileSync(path.join(dir, "body.json"), "utf8"), before);
  });
});
