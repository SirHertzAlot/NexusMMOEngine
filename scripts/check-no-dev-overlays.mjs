#!/usr/bin/env node
/**
 * TL3 gate: verify production bundles contain zero leva/lil-gui bytes.
 *
 * Scans the Vite production output (dist-app) for leva/lil-gui identifiers.
 * Uses word-boundary matching so substrings like "sunElevation" don't
 * trigger false positives. Fails if found. Run after `npm run build` in CI.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Word-boundary regexes: match "leva" / "lil-gui" as standalone identifiers,
// not substrings (e.g. the "leva" inside "sunElevation").
const FORBIDDEN = [/\bleva\b/, /\blil-gui\b/, /\blil_gui\b/];
// Vite production bundles (not the tsc lib output in dist/).
const BUILD_DIRS = [
  "apps/client/dist-app",
  "apps/editor/dist-app",
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
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content)) {
          console.error(`FAIL: ${p} matches ${pattern}`);
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
