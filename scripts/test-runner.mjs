#!/usr/bin/env node
/**
 * Fast monorepo test runner:
 * 1. Prebuilds every workspace once in dependency order (via buildOrder).
 * 2. Runs workspace test suites directly against built dist/ without redundant tsc rebuilds.
 * 3. Runs scripts unit tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { npm, root, run, win } from "./lib/run.mjs";
import { buildOrder } from "./lib/build-order.mjs";

const skipBuild = process.argv.includes("--no-build") || process.env.MMO_SKIP_BUILD === "1";
const start = Date.now();

// 1. Build all workspaces in order once:
if (!skipBuild) {
  console.log("[test-runner] Step 1/2: Prebuilding workspaces in dependency order...");
  for (const name of buildOrder()) {
    npm("prebuild", ["run", "build", `--workspace=${name}`], {
      env: { MMO_ORDERED_BUILD: "1" },
      hint: `${name} failed to build; the error is above`,
    });
  }
} else {
  console.log("[test-runner] Step 1/2: Skipping prebuild (--no-build or MMO_SKIP_BUILD set)...");
}

// 2. Discover workspaces with tests and execute without re-running build:
console.log("\n[test-runner] Step 2/2: Executing workspace test suites...");
const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];

for (const w of workspaces) {
  const pkgFile = join(root, w, "package.json");
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const testScript = pkg.scripts?.test;
  if (!testScript) continue;

  // Strip leading build commands ("npm run build && ", "npm run build:lib && ")
  const stripped = testScript.replace(/^npm run (build|build:lib)\s*&&\s*/, "");
  console.log(`\n--- [${pkg.name}] ${stripped} ---`);

  const r = spawnSync(stripped, {
    cwd: join(root, w),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, MMO_ORDERED_BUILD: "1" },
  });

  if (r.status !== 0) {
    failures.push({ name: pkg.name, status: r.status });
  }
}

// 3. Root script tests:
console.log("\n--- [root:scripts] node --test \"scripts/test/*.test.mjs\" ---");
const scriptTests = spawnSync("node", ["--test", "scripts/test/*.test.mjs"], {
  cwd: root,
  stdio: "inherit",
  shell: win,
  env: process.env,
});
if (scriptTests.status !== 0) {
  failures.push({ name: "scripts", status: scriptTests.status });
}

const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n[test-runner] FAILED in ${elapsedSec}s. ${failures.length} suite(s) failed:`);
  for (const f of failures) console.error(`  - ${f.name} (exit ${f.status})`);
  process.exit(1);
} else {
  console.log(`\n[test-runner] PASSED in ${elapsedSec}s across all workspaces!`);
  process.exit(0);
}
