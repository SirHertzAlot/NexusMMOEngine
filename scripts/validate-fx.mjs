#!/usr/bin/env node
/**
 * scripts/validate-fx.mjs — validate FX asset JSON against the PR1 contract.
 * Usage: node scripts/validate-fx.mjs <file> [--quiet]
 * Exit 0 = valid, 2 = invalid, 1 = usage/IO error.
 *
 * PR1 ships the validator dependency-free (mirrors the zod schema in
 * packages/render-fx/src/asset-schema.ts). The zod schema is the normative
 * definition; this CLI is the offline/CI mirror. Any drift between them is
 * a bug — both are pinned by packages/render-fx/test/asset-schema.test.mjs.
 */
import { readFileSync } from "node:fs";

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
  if (typeof def !== "object" || def === null) return ["root must be an object"];
  if (typeof def.assetId !== "string" || def.assetId.length < 1) issues.push("assetId: required");
  if (def.version !== 1) issues.push(`version: must be 1 (got ${String(def.version)})`);
  if (!["oneshot", "persistent"].includes(def.kind)) issues.push("kind: oneshot|persistent");
  if (!Array.isArray(def.modules) || def.modules.length < 1 || def.modules.length > 8) {
    issues.push("modules: must have 1..8 entries");
  }
  if (!Array.isArray(def.bindings) || def.bindings.length < 1) issues.push("bindings: >= 1 entry required");
  for (const m of def.modules ?? []) {
    if (!MODULES.has(m?.module)) issues.push(`modules: unknown module ${m?.module}`);
    for (const [k, v] of Object.entries(m?.params ?? {})) {
      if (!isParamValue(v)) issues.push(`modules.${m?.module}.${k}: bad ParamValue`);
    }
  }
  if (def.quality !== undefined && !TIERS.has(def.quality?.minTier)) issues.push("quality.minTier: bad tier");
  if (!["fade", "detach", "kill"].includes(def.onOrphan)) issues.push("onOrphan: fade|detach|kill");
  return issues;
}

const file = process.argv[2];
const quiet = process.argv.includes("--quiet");
if (!file) {
  console.error("usage: node scripts/validate-fx.mjs <file> [--quiet]");
  process.exit(1);
}

let json;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`validate-fx: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const issues = validate(json);
if (issues.length > 0) {
  if (!quiet) {
    console.error(`validate-fx: INVALID ${file}`);
    for (const i of issues) console.error(`  - ${i}`);
  }
  process.exit(2);
}
if (!quiet) console.log(`validate-fx: OK ${file}`);
process.exit(0);
