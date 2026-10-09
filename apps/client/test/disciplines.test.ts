import "./strings-setup.js";
/**
 * Disciplines on the sheet: requirement lines, progress, lapse text and goal order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SkillsMessage } from "@mmo-engine/protocol";
import { disciplineProgress, goalsByProgress, lapsedText, requirementLines, techniqueTitle } from "../src/ui/disciplines.js";

const skills: SkillsMessage["skills"] = [
  { id: "cutting", name: "Cutting", value: 40, peak: 80 },
  { id: "parrying", name: "Parrying", value: 70, peak: 70 },
  { id: "medicine", name: "Medicine", value: 0, peak: 0 },
];

describe("disciplines", () => {
  it("titles techniques", () => {
    assert.equal(techniqueTitle("throwDown"), "Throw down");
    assert.equal(techniqueTitle("sweep"), "Sweep");
  });

  it("reads each requirement against the skills now", () => {
    const lines = requirementLines(
      [
        { skill: "cutting", level: 80 },
        { skill: "parrying", level: 70 },
        { skill: "foraging", level: 40 },
      ],
      skills,
    );
    assert.deepEqual(
      lines.map((l) => [l.name, l.value, l.met]),
      [
        ["Cutting", 40, false],
        ["Parrying", 70, true],
        ["Foraging", 0, false],
      ],
    );
    assert.equal(disciplineProgress(lines), (0.5 + 1 + 0) / 3);
    assert.equal(lapsedText(lines), "Cutting below 80, Foraging below 40");
    assert.equal(disciplineProgress([]), 1);
  });

  it("orders goals closest first, rules order on ties", () => {
    const m: SkillsMessage = {
      kind: "skills",
      max: 100,
      skills,
      familiarity: [],
      disciplines: [],
      toward: [
        { id: "surgeon", name: "Field Surgeon", unlocks: ["reattach"], requires: [{ skill: "medicine", level: 75 }] },
        { id: "blade", name: "Blade Master", unlocks: ["disarm"], requires: [{ skill: "cutting", level: 80 }, { skill: "parrying", level: 70 }] },
        { id: "other", name: "Other", unlocks: [], requires: [{ skill: "medicine", level: 10 }] },
      ],
    };
    assert.deepEqual(
      goalsByProgress(m).map((g) => [g.id, g.progress]),
      [
        ["blade", 0.75],
        ["surgeon", 0],
        ["other", 0],
      ],
    );
    assert.deepEqual(goalsByProgress({ ...m, toward: undefined }), []);
  });
});
