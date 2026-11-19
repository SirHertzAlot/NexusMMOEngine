import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  effectDefinitionSchema,
  validateAsset,
  migrateAsset,
  resolveModuleParams,
} from "../src/asset-schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/test/*.js -> repo root is ../../../.. (dist/test -> package -> packages -> repo).
const repoRoot = path.resolve(here, "../../../..");
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));
const chargedShot = readJson("content/vfx/charged-shot.json");
const forceShield = readJson("content/vfx/force-shield.json");

test("spec section 7.1 asset validates against the normative schema", () => {
  const result = validateAsset(chargedShot);
  assert.equal(result.ok, true);
});

test("spec section 7.2 asset validates against the normative schema", () => {
  const result = validateAsset(forceShield);
  assert.equal(result.ok, true);
});

test("normative schema accepts both committed assets directly", () => {
  assert.equal(effectDefinitionSchema.safeParse(chargedShot).success, true);
  assert.equal(effectDefinitionSchema.safeParse(forceShield).success, true);
});

test("8-module cap rejects 9 modules", () => {
  assert.equal((chargedShot as { modules: unknown[] }).modules.length, 4);
  const tooMany = {
    ...(chargedShot as Record<string, unknown>),
    modules: Array.from({ length: 9 }, () => ({ module: "ShellModule", params: {} })),
  };
  const parsed = effectDefinitionSchema.safeParse(tooMany);
  assert.equal(parsed.success, false);
  const result = validateAsset(tooMany);
  assert.equal(result.ok, false);
});

test("unknown module rejected by the normative allow-list", () => {
  const bad = {
    ...(chargedShot as Record<string, unknown>),
    modules: [{ module: "NopeModule", params: {} }],
  };
  assert.equal(validateAsset(bad).ok, false);
});

test("bad ParamValue type rejected (non-finite number)", () => {
  const bad = {
    ...(chargedShot as Record<string, unknown>),
    modules: [{ module: "ShellModule", params: { power: Number.NaN } }],
  };
  assert.equal(validateAsset(bad).ok, false);
});

test("bad ParamValue shape rejected (1- and 2-element arrays are neither vec3 nor LUT)", () => {
  for (const badArr of [[1], [1, 2]]) {
    const bad = {
      ...(chargedShot as Record<string, unknown>),
      modules: [{ module: "ShellModule", params: { offset: badArr } }],
    };
    assert.equal(validateAsset(bad).ok, false, `array ${JSON.stringify(badArr)} should reject`);
  }
});

test("bad binding kind rejected", () => {
  const bad = {
    ...(chargedShot as Record<string, unknown>),
    bindings: [{ kind: "orbit" }],
  };
  assert.equal(validateAsset(bad).ok, false);
});

test("slotCaps.low=0 accepted (disabled-on-Low fallback)", () => {
  const result = validateAsset(forceShield);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.def.quality.slotCaps?.low, 0);
});

test("slotCaps rejects negative counts", () => {
  const bad = {
    ...(forceShield as Record<string, unknown>),
    quality: { minTier: "low", slotCaps: { low: -1 } },
  };
  assert.equal(validateAsset(bad).ok, false);
});

test("bad minTier rejected", () => {
  const bad = {
    ...(chargedShot as Record<string, unknown>),
    quality: { minTier: "potato" },
  };
  assert.equal(validateAsset(bad).ok, false);
});

test("unsupported version rejected by migrateAsset", () => {
  assert.throws(
    () => migrateAsset({ ...(chargedShot as Record<string, unknown>), version: 2 }),
    /unsupported version/,
  );
});

test("migrateAsset returns the validated definition for v1", () => {
  const def = migrateAsset(chargedShot);
  assert.equal(def.assetId, "fx.charged-shot");
  assert.equal(def.version, 1);
});

test("$param indirection resolves from defaults via the real export", () => {
  const result = validateAsset(chargedShot);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(resolveModuleParams(result.def, 0).rimColor, "#ff5522");
});

test("$param override wins over the default", () => {
  const result = validateAsset(chargedShot);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(resolveModuleParams(result.def, 0, { bodyColor: "#000000" }).rimColor, "#000000");
});

test("unknown $param reference throws from the real export", () => {
  const result = validateAsset(chargedShot);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const def = {
    ...result.def,
    modules: [{ module: "ShellModule", params: { x: "$missing" } }],
  } as typeof result.def;
  assert.throws(() => resolveModuleParams(def, 0), /unknown param reference/);
});
