#!/usr/bin/env node
/**
 * TL3 gate: verify production bundles contain zero leva/lil-gui bytes.
 *
 * Scans the built output for leva/lil-gui identifiers. Fails if found.
 * Run after `npm run build` in CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["leva", "lil-gui", "lil_gui"];
const BUILD_DIRS = [
  "apps/client/dist",
  "apps/editor/dist",
];

let found = false;

function scanDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    console.log(`skip: ${dir} (not built)`);
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      scanDir(p);
    } else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) {
      const content = readFileSync(p, "utf8");
      for (const term of FORBIDDEN) {
        if (content.includes(term)) {
          console.error(`FAIL: ${p} contains "${term}"`);
          found = true;
        }
      }
    }
  }
}

for (const dir of BUILD_DIRS) {
  scanDir(dir);
}

if (found) {
  console.error("\nTL3 gate FAILED: dev overlay code in production bundle");
  process.exit(1);
} else {
  console.log("\nTL3 gate PASSED: no leva/lil-gui in production bundles");
}
