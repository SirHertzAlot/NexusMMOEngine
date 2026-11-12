/**
 * The authored cel ramp is validated like other art data: the shipped
 * content is clean, and an inverted shadow band is rejected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMaterials } from "../src/media/materials.js";

const content = () => JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/materials/materials.json", import.meta.url)), "utf8"));

describe("cel ramp validation", () => {
  it("the shipped materials.json validates", () => {
    assert.deepEqual(validateMaterials(content()), []);
  });

  it("rejects a shadow darker-than-edge inversion (the shadow lighter than its edge)", () => {
    const doc = content();
    doc.toon.ramp.cloth.day = [[0.9, 0.9, 0.9], [0.1, 0.1, 0.1]];
    const issues = validateMaterials(doc);
    assert.ok(issues.some((i) => i.path === "toon.ramp.cloth.day"), JSON.stringify(issues));
  });
});
