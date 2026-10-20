/**
 * Needs schema: NeedDef catalog rows, SpeciesNeeds declarations, NeedState,
 * versioning and provenance. Unknown schema versions are rejected loudly,
 * never guessed. The schema definition files reference no species ids
 * (proposal invariant 4); the systems contain no species-name string
 * literals (proposal invariant 1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEEDS_SCHEMA_VERSION,
  NeedCatalogSchema,
  NeedDefSchema,
  NeedStateSchema,
  SpeciesNeedsSchema,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "src"); // tests run from dist/test

const goodNeed = {
  id: "need:hydration.fresh",
  schemaVersion: 1,
  category: "water",
  decayPerHour: 0.08,
  thresholds: { uneasy: 0.6, urgent: 0.35, critical: 0.15 },
  conditionFields: ["water.fresh", "water.salinity"],
  requirement: [
    { field: "water.salinity", anchors: [[0, 1], [0.05, 0.9], [0.2, 0.2], [1, 0]], hardBounds: [0, 0.05] },
    { field: "water.fresh", anchors: [[0, 0], [0.3, 0.5], [0.7, 1]] },
  ],
  actions: ["drink", "seek-water", "migrate"],
  provenance: { script: "needs/water.scm", author: "design" },
};

const goodSpeciesNeeds = {
  speciesId: "mire-newt",
  schemaVersion: 1,
  needs: {
    "need:hydration.fresh": { weight: 3.0, tolerance: 0.15 },
  },
  variantAxes: ["biome", "size"],
  provenance: { script: "species/wetlands.scm", author: "design" },
};

describe("NeedDef", () => {
  it("accepts a well-formed row", () => {
    const r = NeedDefSchema.safeParse(goodNeed);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.equal(r.data!.id, "need:hydration.fresh");
  });

  it("rejects an unknown schemaVersion loudly, never guessing", () => {
    const r = NeedDefSchema.safeParse({ ...goodNeed, schemaVersion: 2 });
    assert.ok(!r.success);
    assert.match(r.error!.issues.map((i) => i.message).join(" "), /schemaVersion/i);
  });

  it("rejects thresholds that do not strictly decrease", () => {
    const r = NeedDefSchema.safeParse({ ...goodNeed, thresholds: { uneasy: 0.35, urgent: 0.6, critical: 0.15 } });
    assert.ok(!r.success);
  });

  it("rejects anchors that are not sorted by field value", () => {
    const bad = structuredClone(goodNeed);
    bad.requirement[1].anchors = [[0.7, 1], [0.3, 0.5], [0, 0]];
    assert.ok(!NeedDefSchema.safeParse(bad).success);
  });

  it("rejects satisfaction outside 0..1 and decayPerHour outside 0..1", () => {
    const bad = structuredClone(goodNeed);
    bad.requirement[0].anchors = [[0, 1.5], [1, 0]];
    assert.ok(!NeedDefSchema.safeParse(bad).success);
    assert.ok(!NeedDefSchema.safeParse({ ...goodNeed, decayPerHour: 1.5 }).success);
  });

  it("rejects a row without provenance", () => {
    const { provenance: _dropped, ...rest } = goodNeed;
    assert.ok(!NeedDefSchema.safeParse(rest).success);
  });

  it("rejects need ids outside the need: namespace", () => {
    assert.ok(!NeedDefSchema.safeParse({ ...goodNeed, id: "hydration" }).success);
  });
});

describe("SpeciesNeeds", () => {
  it("accepts a well-formed declaration; species tune only weight and tolerance", () => {
    const r = SpeciesNeedsSchema.safeParse(goodSpeciesNeeds);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.deepEqual(Object.keys(r.data!.needs["need:hydration.fresh"]), ["weight", "tolerance"]);
  });

  it("rejects an unknown schemaVersion loudly", () => {
    const r = SpeciesNeedsSchema.safeParse({ ...goodSpeciesNeeds, schemaVersion: 99 });
    assert.ok(!r.success);
    assert.match(r.error!.issues.map((i) => i.message).join(" "), /schemaVersion/i);
  });

  it("rejects negative weights and tolerance outside 0..1", () => {
    const bad = structuredClone(goodSpeciesNeeds);
    bad.needs["need:hydration.fresh"].weight = -1;
    assert.ok(!SpeciesNeedsSchema.safeParse(bad).success);
    const bad2 = structuredClone(goodSpeciesNeeds);
    bad2.needs["need:hydration.fresh"].tolerance = 1.5;
    assert.ok(!SpeciesNeedsSchema.safeParse(bad2).success);
  });
});

describe("NeedState", () => {
  it("accepts per-entity runtime state", () => {
    const r = NeedStateSchema.safeParse({ entityId: 7, levels: { "need:hydration.fresh": 0.42 }, updatedTick: 120 });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("rejects levels outside 0..1", () => {
    assert.ok(!NeedStateSchema.safeParse({ entityId: 7, levels: { "need:hydration.fresh": 1.2 }, updatedTick: 0 }).success);
  });
});

describe("NeedCatalog", () => {
  it("accepts the envelope and rejects duplicate need ids", () => {
    const ok = NeedCatalogSchema.safeParse({ schemaVersion: 1, needs: [goodNeed] });
    assert.ok(ok.success, JSON.stringify(ok.error?.issues));
    const dup = NeedCatalogSchema.safeParse({ schemaVersion: 1, needs: [goodNeed, goodNeed] });
    assert.ok(!dup.success);
  });
});

describe("proposal invariants", () => {
  // Invariant 1: no species-name string literals in the systems.
  // Invariant 4: the schema definition files reference no species ids.
  // The species ids come from the shipped sample pack (content), never from code.
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const srcText = srcFiles.map((f) => readFileSync(join(srcDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, ""));
  const packIds = ["goblin", "orc", "troll", "ogre", "wolf", "bear", "boar", "giant-spider", "skeleton", "ghoul", "wraith", "bone-champion", "lich", "imp", "fiend", "infernal-brute", "pit-lord", "elemental-shard", "void-watcher"];

  it("schema definition files reference no species ids (invariant 4)", () => {
    const schemaFiles = ["needs.ts", "suitability.ts", "need-state.ts"];
    for (const f of schemaFiles) {
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const id of packIds) {
        assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `${f} references species id ${id}`);
      }
    }
  });

  it("no species source file contains a species-name string literal (invariant 1)", () => {
    for (const [i, text] of srcText.entries()) {
      for (const id of packIds) {
        assert.ok(!new RegExp(`['"\`]${id}['"\`]`).test(text), `${srcFiles[i]} contains species-name literal '${id}'`);
      }
    }
  });

  it("NEEDS_SCHEMA_VERSION is 1", () => {
    assert.equal(NEEDS_SCHEMA_VERSION, 1);
  });
});
