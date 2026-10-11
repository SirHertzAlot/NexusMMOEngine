#!/usr/bin/env node
/**
 * npm run valgrind:build-debug [-- addon ...]
 *
 * Rebuilds the native addons with `-g` so memcheck's stacks carry source file
 * and line numbers for our code (the dashboard shows them on engine errors).
 * `-g` adds symbols only: the generated code, and so callgrind's instruction
 * counts, are the same as the normal build. Run `npm run valgrind:memcheck`
 * after it to get stacks with locations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib.mjs";

const only = process.argv.slice(2);
const dir = join(root, "packages", "addons");
const addons = readdirSync(dir).filter((n) => existsSync(join(dir, n, "binding.gyp")) && (only.length === 0 || only.includes(n)));
if (addons.length === 0) { console.error("[build-debug] no addons with a binding.gyp" + (only.length ? ` among: ${only.join(", ")}` : "")); process.exit(2); }

let failed = 0;
for (const name of addons) {
  const t0 = Date.now();
  const r = spawnSync("npx", ["node-gyp", "rebuild"], {
    cwd: join(dir, name), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CFLAGS: "-g", CXXFLAGS: "-g" }, shell: process.platform === "win32",
  });
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status === 0) console.log(`[build-debug] ${name}: built with -g (${s}s)`);
  else { failed++; console.error(`[build-debug] ${name}: FAILED (${s}s)\n${(r.stderr || r.stdout).slice(-1500)}`); }
}
process.exit(failed ? 1 : 0);
