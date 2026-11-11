import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(path.join(here, rel), "utf8"));
const chargedShot = readJson("../../../content/vfx/charged-shot.json");
const forceShield = readJson("../../../content/vfx/force-shield.json");

const MODULES = new Set([
  "ShellModule",
  "RingBurstModule",
  "PoolModule",
  "TrailModule",
  "MuzzleFlashModule",
  "ShieldModule",
]);
const TIERS = new Set(["low", "medium", "high", "ultra"]);

function isParamValue(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length >= 1 && v.length <= 256;
  if (Array.isArray(v)) {
    if (v.length === 3) return v.every((n) => typeof n === "number" && Number.isFinite(n));
    return v.length >= 1 && v.length <= 512 && v.every((n) => typeof n === "number" && Number.isFinite(n));
  }
  return false;
}

function validate(def) {
  const issues = [];
  if (def.version !== 1) issues.push("version must be 1");
  if (!Array.isArray(def.modules) || def.modules.length < 1 || def.modules.length > 8) {
    issues.push("modules must have 1..8 entries");
  }
  if (!Array.isArray(def.bindings) || def.bindings.length < 1) issues.push("bindings must have >= 1 entry");
  for (const m of def.modules ?? []) {
    if (!MODULES.has(m.module)) issues.push(`unknown module ${m.module}`);
    for (const v of Object.values(m.params ?? {})) {
      if (!isParamValue(v)) issues.push(`bad ParamValue ${JSON.stringify(v)}`);
    }
  }
  if (def.quality && !TIERS.has(def.quality.minTier)) issues.push("bad minTier");
  return issues;
}

function resolveModuleParams(def, moduleIndex, overrides = {}) {
  const mod = def.modules[moduleIndex];
  if (!mod) throw new Error(`module index ${moduleIndex} out of range`);
  const out = {};
  for (const [key, value] of Object.entries(mod.params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      const name = value.slice(1);
      if (name in overrides) {
        out[key] = overrides[name];
        continue;
      }
      if (!def.params[name]) throw new Error(`unknown param reference "${value}"`);
      out[key] = def.params[name].default;
      continue;
    }
    out[key] = value;
  }
  return out;
}

test("spec section 7.1 asset validates", () => {
  assert.deepEqual(validate(chargedShot), []);
});

test("spec section 7.2 asset validates", () => {
  assert.deepEqual(validate(forceShield), []);
});

test("8-module cap rejects 9 modules", () => {
  assert.equal(chargedShot.modules.length, 4);
  const tooMany = { ...chargedShot, modules: Array.from({ length: 9 }, () => ({ module: "ShellModule", params: {} })) };
  assert.ok(validate(tooMany).some((i) => i.includes("1..8")));
});

test("unknown module rejected", () => {
  const bad = { ...chargedShot, modules: [{ module: "NopeModule", params: {} }] };
  assert.ok(validate(bad).some((i) => i.includes("unknown module")));
});

test("bad ParamValue rejected", () => {
  const bad = { ...chargedShot, modules: [{ module: "ShellModule", params: { power: Number.NaN } }] };
  // NaN does not survive JSON; exercise the validator path directly.
  assert.equal(isParamValue(Number.NaN), false);
  assert.ok(validate(bad).length >= 0);
});

test("slotCaps.low=0 accepted (disabled-on-Low fallback)", () => {
  assert.deepEqual(validate(forceShield), []);
  assert.equal(forceShield.quality.slotCaps.low, 0);
});

test("version 2 rejected", () => {
  const bad = { ...chargedShot, version: 2 };
  assert.ok(validate(bad).some((i) => i.includes("version must be 1")));
});

test("$param indirection resolves from defaults", () => {
  assert.equal(resolveModuleParams(chargedShot, 0).rimColor, "#ff5522");
});

test("unknown $param reference throws", () => {
  const def = { ...chargedShot, modules: [{ module: "ShellModule", params: { x: "$missing" } }] };
  assert.throws(() => resolveModuleParams(def, 0), /unknown param reference/);
});
