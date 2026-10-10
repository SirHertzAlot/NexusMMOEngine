#!/usr/bin/env node
/**
 * Build native (N-API) module entries (EA10).
 *
 * Scans modules/<name>/module.json for a `native.entry` (a compiled `.node`
 * file). For each module whose entry is missing, runs `node-gyp rebuild` in
 * the module directory (the module ships its own binding.gyp, following the
 * packages/addons template). Modules already built are skipped unless
 * --force is passed.
 *
 * Usage: npm run build:native [-- --force]
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = join(root, "modules");
const force = process.argv.includes("--force");

if (!existsSync(modulesDir)) {
  console.log("build:native: no modules/ directory, nothing to do");
  process.exit(0);
}

let built = 0;
let skipped = 0;
let failed = 0;
for (const d of readdirSync(modulesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()) {
  const manifestFile = join(modulesDir, d, "module.json");
  if (!existsSync(manifestFile)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    console.log(`build:native: ${d}: module.json is not valid JSON, skipping`);
    continue;
  }
  const entry = manifest?.native?.entry;
  if (typeof entry !== "string") continue;
  const target = join(modulesDir, d, entry);
  if (existsSync(target) && !force) {
    skipped++;
    continue;
  }
  const binding = join(modulesDir, d, "binding.gyp");
  if (!existsSync(binding)) {
    console.log(`build:native: ${d}: no binding.gyp, cannot build "${entry}"`);
    failed++;
    continue;
  }
  console.log(`build:native: building ${d} ...`);
  try {
    execSync("npx node-gyp rebuild", { cwd: join(modulesDir, d), stdio: "inherit" });
    built++;
  } catch {
    console.log(`build:native: ${d}: build failed`);
    failed++;
  }
}

console.log(`build:native: built ${built}, up-to-date ${skipped}, failed ${failed}`);
if (failed > 0) process.exit(1);
