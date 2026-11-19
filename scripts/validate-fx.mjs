#!/usr/bin/env node
/**
 * scripts/validate-fx.mjs — validate FX asset JSON against the normative schema.
 * Usage: node scripts/validate-fx.mjs <file> [--quiet]
 * Exit 0 = valid, 2 = invalid, 1 = usage/IO error (including missing build output).
 *
 * Consumes the built normative exports from packages/render-fx/dist
 * (validateAsset). No independent validation logic lives here; run the
 * package build first (`npm run build --workspace=@mmo-engine/render-fx`).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = process.argv[2];
const quiet = process.argv.includes("--quiet");
if (!file) {
  console.error("usage: node scripts/validate-fx.mjs <file> [--quiet]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let validateAsset;
try {
  ({ validateAsset } = require(path.join(here, "../packages/render-fx/dist/src/asset-schema.js")));
} catch (e) {
  console.error(
    "validate-fx: missing build output at packages/render-fx/dist/src/asset-schema.js — " +
      "run `npm run build --workspace=@mmo-engine/render-fx` first.",
  );
  console.error(`validate-fx: loader error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`validate-fx: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const result = validateAsset(json);
if (!result.ok) {
  if (!quiet) {
    console.error(`validate-fx: INVALID ${file}`);
    for (const i of result.issues) console.error(`  - ${i}`);
  }
  process.exit(2);
}
if (!quiet) console.log(`validate-fx: OK ${file}`);
process.exit(0);
