/**
 * The rules: our game's rule set loads and passes every check; bad files
 * are reported by file and field; the default hooks reproduce the design
 * doc's worked numbers; a game's override wraps the default.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHooks,
  decaySkill,
  engineDefaults,
  loadRules,
  parseRules,
  partAndBelow,
  RulesError,
  type Rules,
} from "../src/index.js";

/** The repo's content/rules (this file runs from packages/rules/dist/test). */
const OUR_RULES = fileURLToPath(new URL("../../../../content/rules", import.meta.url));

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulesError) return e.issues.map((i) => `${i.file}${i.path ? `: ${i.path}` : ""}: ${i.message}`);
    throw e;
  }
  assert.fail("expected a RulesError");
}

describe("our game's rules (content/rules)", () => {
  const rules = loadRules(OUR_RULES);

  it("load and pass every check", () => {
    assert.equal(rules.skills.skills.length, 18);
    assert.equal(rules.body.parts.length, 11);
    assert.equal(rules.skills.decay.ratePerWeek, 0.01);
    assert.equal(rules.death.respawn.at, "nearestVisited");
  });

  it("body parts are the modular character's body slots, and lose everything below them", () => {
    for (const p of rules.body.parts) assert.equal(p.slot, p.id);
    assert.deepEqual(partAndBelow(rules, "armUpperLeft"), ["armUpperLeft", "armLowerLeft", "handLeft"]);
    assert.deepEqual(partAndBelow(rules, "hips").sort(), ["hips", "legLeft", "legRight"]);
  });

  it("reproduce the worked damage example (docs/MASTERY-AND-COMBAT.md §3.2)", () => {
    const h = createHooks(rules);
    const sword = { mass: 1.3, edge: 0.9, point: 0.8, hardness: 0.9 };
    const stick = { mass: 0.8, edge: 0.05, point: 0.2, hardness: 0.4 };
    const novice = h.computeDamage({ technique: "cut", skill: 5, item: sword, part: "torso" });
    const masterStick = h.computeDamage({ technique: "cut", skill: 100, item: stick, part: "head" });
    const masterSword = h.computeDamage({ technique: "cut", skill: 100, item: sword, part: "head" });
    assert.equal(novice.kind, "cut");
    assert.ok(Math.abs(novice.amount - 4.3) < 0.05, `novice with a sword: ${novice.amount}`);
    assert.ok(Math.abs(masterStick.amount - 29) < 0.5, `master with a stick: ${masterStick.amount}`);
    assert.ok(Math.abs(masterSword.amount - 45) < 0.5, `master with a sword: ${masterSword.amount}`);
  });

  it("deteriorate slowly: ~94 after two months, the floor after about a year", () => {
    assert.equal(decaySkill(rules, 100, 100, 14), 100, "within the grace");
    const twoMonths = decaySkill(rules, 100, 100, 60);
    assert.ok(twoMonths > 93 && twoMonths < 95, `${twoMonths}`);
    assert.ok(decaySkill(rules, 100, 100, 330) > 60, "not at the floor before ~a year");
    assert.equal(decaySkill(rules, 100, 100, 400), 60, "the floor: 60% of the peak");
    assert.equal(decaySkill(rules, 50, 100, 400), 50, "never raised by the floor");
  });

  it("decide harm, maim and dismember by the table (§4.2)", () => {
    const h = createHooks(rules);
    const hit = (kind: "cut" | "blunt" | "thrust", damage: number, state: "healthy" | "harmed" | "maimed" = "healthy", hp = 10) =>
      h.onInjury({ part: "armUpperLeft", kind, damage, hp, maxHp: 10, state }).state;
    assert.equal(hit("cut", 2), "harmed");
    assert.equal(hit("cut", 5), "maimed");
    assert.equal(hit("cut", 9), "dismembered");
    assert.equal(hit("cut", 4, "maimed"), "dismembered", "40% on a maimed part");
    assert.equal(hit("blunt", 4), "maimed", "a broken bone");
    assert.equal(hit("blunt", 10), "maimed", "blunt never dismembers");
    assert.equal(hit("thrust", 5), "harmed");
    assert.equal(hit("thrust", 6), "maimed");
    assert.equal(hit("thrust", 2, "healthy", 2), "maimed", "at 0 health");
  });

  it("land blows by precision: 30% for a novice, 95% for a master, neighbours otherwise", () => {
    const h = createHooks(rules);
    let seed = 7;
    const rng = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const rate = (skill: number): number => {
      let onAim = 0;
      for (let i = 0; i < 4000; i++) if (h.resolveLanding({ aim: "head", skill, rng }) === "head") onAim++;
      return onAim / 4000;
    };
    assert.ok(Math.abs(rate(0) - 0.3) < 0.03, `novice ${rate(0)}`);
    assert.ok(Math.abs(rate(100) - 0.95) < 0.02, `master ${rate(100)}`);
    // A miss on the head lands on its only neighbour, the torso.
    const misses = new Set<string>();
    for (let i = 0; i < 200; i++) misses.add(h.resolveLanding({ aim: "head", skill: 0, rng }));
    assert.deepEqual([...misses].sort(), ["head", "torso"]);
    // Aimed at a lost hand: goes for the forearm.
    assert.equal(h.resolveLanding({ aim: "handLeft", skill: 100, rng: () => 0, dismembered: new Set(["handLeft"]) }), "armLowerLeft");
  });

  it("teach by challenge: nothing when trivial, most near your level, slower at the top", () => {
    const h = createHooks(rules);
    assert.equal(h.skillGain({ skill: 80, peak: 80, difficulty: 0.4 }), 0, "far below: nothing");
    const novice = h.skillGain({ skill: 10, peak: 10, difficulty: 0.1 });
    const expert = h.skillGain({ skill: 90, peak: 90, difficulty: 0.9 });
    assert.ok(novice > expert * 10, `${novice} vs ${expert}`);
    assert.ok(h.skillGain({ skill: 50, peak: 50, difficulty: 0.5, recentUses: 5 }) < h.skillGain({ skill: 50, peak: 50, difficulty: 0.5 }), "farming the same target");
    assert.ok(h.skillGain({ skill: 50, peak: 90, difficulty: 0.5 }) > h.skillGain({ skill: 50, peak: 50, difficulty: 0.5 }), "relearning is faster");
  });

  it("respawn with skills kept and injuries cleared", () => {
    const h = createHooks(rules);
    const outcome = h.onDeath({ cause: "part", part: "head" });
    assert.equal(outcome.respawnInSeconds, 10);
    assert.equal(outcome.keepSkills, true);
    assert.deepEqual(h.onRespawn({ outcome }), { clearInjuries: true, restoreParts: true });
  });
});

describe("engine defaults", () => {
  it("are neutral: one body part, no skills, no decay", () => {
    const d: Rules = engineDefaults();
    assert.deepEqual(d.body.parts.map((p) => p.id), ["body"]);
    assert.equal(d.skills.skills.length, 0);
    assert.equal(d.skills.decay.ratePerWeek, 0);
    assert.equal(d.body.severity.cut.dismember, null, "nothing is lost by default");
  });

  it("fill whatever a file leaves out", () => {
    const r = parseRules({ combat: { damage: { base: 20 } } });
    assert.equal(r.combat.damage.base, 20);
    assert.equal(r.combat.damage.massPower, 0.5, "the rest stays at the default");
    assert.equal(r.combat.precision.novice, 0.3);
  });
});

describe("bad rules", () => {
  it("name the file and field, all at once", () => {
    const issues = issuesOf(() =>
      parseRules({
        body: { parts: [{ id: "torso", name: "Torso", parent: null, share: 1.5 }] },
        combat: { damge: {} },
      }),
    );
    assert.ok(issues.some((i) => i.startsWith("body.json: parts[0].share:")), issues.join("\n"));
    assert.ok(issues.some((i) => i.startsWith("combat.json") && /damge/.test(i)), "a misspelt field is an error");
  });

  it("catch what spans files: missing skills, a broken body tree, shares that don't add up", () => {
    const issues = issuesOf(() =>
      parseRules({
        skills: { skills: [{ id: "cutting", name: "Cutting", family: "weapon", related: { sawing: 0.1 } }] },
        disciplines: { disciplines: [{ id: "x", name: "X", requires: { staffs: 50 } }] },
        body: {
          parts: [
            { id: "torso", name: "Torso", parent: null, share: 0.5 },
            { id: "head", name: "Head", parent: "neck", share: 0.3 },
          ],
        },
        appearance: { slots: [{ id: "helmet", part: "skull" }] },
      }),
    );
    for (const want of [
      'skills.json: skills[0].related.sawing: no skill "sawing"',
      'disciplines.json: disciplines[0].requires.staffs: no skill "staffs"',
      'body.json: parts[1].parent: no part "neck"',
      "body.json: parts: shares add up to 0.800, not 1",
      'appearance.json: slots[0].part: no body part "skull"',
    ]) {
      assert.ok(issues.includes(want), `missing "${want}" in:\n${issues.join("\n")}`);
    }
  });

  it("report cross-file problems even when another file failed its schema", () => {
    const issues = issuesOf(() =>
      parseRules({
        skills: { decay: { ratePerWeak: 0.02 } },
        body: { parts: [{ id: "torso", name: "Torso", parent: null, share: 0.5 }] },
        disciplines: { disciplines: [{ id: "x", name: "X", requires: { cutting: 50 } }] },
      }),
    );
    assert.ok(issues.some((i) => i.startsWith("skills.json: decay") && /ratePerWeak/.test(i)), issues.join("\n"));
    assert.ok(issues.includes("body.json: parts: shares add up to 0.500, not 1"), issues.join("\n"));
    assert.ok(!issues.some((i) => i.startsWith("disciplines.json")), "no false alarm about skills a broken skills.json would have defined");
  });

  it("reject unknown and unreadable files in the folder, alongside every other problem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
    fs.writeFileSync(path.join(dir, "skils.json"), "{}");
    fs.writeFileSync(path.join(dir, "body.json"), "{ nope");
    fs.writeFileSync(path.join(dir, "combat.json"), JSON.stringify({ damage: { base: -1 } }));
    fs.writeFileSync(path.join(dir, "appearance.json"), JSON.stringify({ slots: [{ id: "helmet", part: "head" }] }));
    const issues = issuesOf(() => loadRules(dir));
    assert.ok(issues.some((i) => i.startsWith("skils.json: not a rules file")), issues.join("\n"));
    assert.ok(issues.some((i) => i.startsWith("body.json: not valid JSON")), issues.join("\n"));
    assert.ok(issues.some((i) => i.startsWith("combat.json: damage.base")), "schema problems reported in the same run");
    assert.ok(!issues.some((i) => i.startsWith("appearance.json")), "no false alarm about parts an unreadable body.json would have defined");
    assert.deepEqual(issuesOf(() => loadRules(path.join(dir, "missing"))).length, 1);
  });

  it("a file holding null is an error, not the defaults", () => {
    const issues = issuesOf(() => parseRules({ skills: null }));
    assert.ok(issues.some((i) => i.startsWith("skills.json:")), issues.join("\n"));
  });

  it("a body can't have more parts than the Injury component holds", () => {
    const parts = Array.from({ length: 16 }, (_, i) => ({
      id: `p${i}`,
      name: `Part ${i}`,
      parent: i === 0 ? null : "p0",
      share: 1 / 16,
    }));
    const issues = issuesOf(() => parseRules({ body: { parts } }));
    assert.ok(issues.some((i) => i.startsWith("body.json: parts: ") && /at most 15 parts/.test(i)), issues.join("\n"));
    assert.doesNotThrow(() => parseRules({ body: { parts: parts.slice(0, 15).map((p) => ({ ...p, share: 1 / 15 })) } }));
  });

  it("an empty folder is the engine default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
    assert.deepEqual(loadRules(dir), engineDefaults());
  });
});

describe("hook overrides", () => {
  it("replace one decision and can call the default", () => {
    const rules = loadRules(OUR_RULES);
    const hooks = createHooks(rules, {
      computeDamage: (input, base) => {
        const d = base(input);
        return { ...d, amount: d.amount * 2 };
      },
    });
    const plain = createHooks(rules);
    const input = { technique: "bludgeon", skill: 50, item: { mass: 1, edge: 0, point: 0, hardness: 0.5 }, part: "torso" };
    assert.equal(hooks.computeDamage(input).amount, plain.computeDamage(input).amount * 2);
    assert.equal(hooks.skillGain({ skill: 1, peak: 1, difficulty: 0.1 }), plain.skillGain({ skill: 1, peak: 1, difficulty: 0.1 }), "the rest untouched");
  });
});
