/** The rig overrides document: strict schema, the edits the Rig view makes, and the committed example. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearModel, DEFAULT_LIMIT, emptyRigs, modelRig, setActive, setHint, setLimit, setTarget, validateRigs, type RigDoc,
} from "../src/rig-doc.js";

const paths = (doc: unknown): string[] => validateRigs(doc).map((i) => i.path);
const OK: RigDoc = {
  version: 1,
  models: {
    "demo-pack/Demo_Deer_01": {
      bodyPlan: "quadruped",
      headSign: -1,
      legTop: 0.42,
      knee: 0.2,
      limits: { legFL: { min: 20, max: 160 } },
      targets: { legFL: { offset: [0, 0.1, 0.2], pole: [0, 0, 1], weight: 0.5 } },
      inactive: ["tail"],
    },
  },
};

describe("validateRigs", () => {
  it("accepts the empty document and a full one", () => {
    assert.deepEqual(validateRigs(emptyRigs()), []);
    assert.deepEqual(validateRigs(OK), []);
  });
  it("refuses non-documents, wrong versions and unknown keys", () => {
    assert.ok(paths(null).includes(""));
    assert.ok(paths({ version: 2, models: {} }).includes("version"));
    assert.ok(paths({ version: 1, models: {}, extra: 1 }).includes("extra"));
    assert.ok(paths({ version: 1, models: { "a/b": { bogus: 1 } } }).includes("models.a/b.bogus"));
  });
  it("names the field that is wrong", () => {
    const bad = (rig: unknown): string[] => paths({ version: 1, models: { "a/b": rig } });
    assert.ok(bad({ headSign: 2 }).includes("models.a/b.headSign"));
    assert.ok(bad({ legTop: 1.5 }).includes("models.a/b.legTop"));
    assert.ok(bad({ knee: -1 }).includes("models.a/b.knee"));
    assert.ok(bad({ bodyPlan: "biped" }).includes("models.a/b.bodyPlan"));
    assert.ok(bad({ limits: { knee: { min: 90, max: 30 } } }).includes("models.a/b.limits.knee"));
    assert.ok(bad({ limits: { knee: { min: -5, max: 30 } } }).includes("models.a/b.limits.knee.min"));
    assert.ok(bad({ limits: { knee: { min: 0, max: 181 } } }).includes("models.a/b.limits.knee.max"));
    assert.ok(bad({ targets: { foot: { offset: [0, 0], weight: 1 } } }).includes("models.a/b.targets.foot.offset"));
    assert.ok(bad({ targets: { foot: { offset: [0, 0, NaN], weight: 1 } } }).includes("models.a/b.targets.foot.offset"));
    assert.ok(bad({ targets: { foot: { offset: [0, 0, 0], weight: 2 } } }).includes("models.a/b.targets.foot.weight"));
    assert.ok(bad({ targets: { foot: { offset: [0, 0, 0], weight: 1, pole: [0, 0, 0] } } }).includes("models.a/b.targets.foot.pole"));
    assert.ok(bad({ inactive: ["a", "a"] }).includes("models.a/b.inactive"));
    assert.ok(bad({ inactive: [3] }).includes("models.a/b.inactive"));
  });
  it("refuses ids and bone names that could be anything", () => {
    assert.ok(paths({ version: 1, models: { "../x": {} } }).length > 0);
    assert.ok(paths({ version: 1, models: { "a b": {} } }).length > 0);
    assert.ok(paths({ version: 1, models: { "a/b": { limits: { "<b>": { min: 0, max: 10 } } } } }).length > 0);
  });
  it("the committed example is valid and uses only synthetic ids", () => {
    const example = JSON.parse(readFileSync(resolve(process.cwd(), "..", "..", "content", "rigs.example.json"), "utf8")) as RigDoc;
    assert.deepEqual(validateRigs(example), []);
    for (const id of Object.keys(example.models)) assert.match(id, /^example-pack\//);
  });
});

describe("rig edits", () => {
  it("setHint adds, changes and removes a hint without touching the input", () => {
    const a = setHint(emptyRigs(), "p/m", { headSign: 1 });
    assert.equal(modelRig(a, "p/m").headSign, 1);
    const b = setHint(a, "p/m", { headSign: undefined });
    assert.equal("p/m" in b.models, false, "an empty override is dropped");
    assert.equal(modelRig(a, "p/m").headSign, 1);
  });
  it("setLimit and setTarget are per bone, and removable", () => {
    let d = setLimit(emptyRigs(), "p/m", "knee", { min: 10, max: 140 });
    d = setTarget(d, "p/m", "legFL", { offset: [0, 0, 0.1], weight: 1 });
    assert.deepEqual(modelRig(d, "p/m").limits?.knee, { min: 10, max: 140 });
    d = setLimit(d, "p/m", "knee", undefined);
    d = setTarget(d, "p/m", "legFL", undefined);
    assert.equal("p/m" in d.models, false);
  });
  it("setActive records only what is switched off", () => {
    let d = setActive(emptyRigs(), "p/m", "tail", false);
    d = setActive(d, "p/m", "tail", false);
    assert.deepEqual(modelRig(d, "p/m").inactive, ["tail"]);
    d = setActive(d, "p/m", "tail", true);
    assert.equal("p/m" in d.models, false);
  });
  it("clearModel drops every override of one model", () => {
    assert.equal("demo-pack/Demo_Deer_01" in clearModel(OK, "demo-pack/Demo_Deer_01").models, false);
  });
  it("modelRig of an unknown model is empty and the default limit is a knee that bends one way", () => {
    assert.deepEqual(modelRig(emptyRigs(), "x/y"), {});
    assert.ok(DEFAULT_LIMIT.min > 0 && DEFAULT_LIMIT.max <= 180);
  });
});
