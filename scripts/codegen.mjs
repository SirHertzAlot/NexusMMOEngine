#!/usr/bin/env node
/**
 * Regenerate FlatBuffers bindings from the single source of truth.
 *
 *   npm run codegen                      writes packages/schema/generated/{cpp,ts}
 *   OUT_DIR=/tmp/gen npm run codegen     reproducibility check target
 *
 * flatc is vendored per platform under third_party/flatc/ (official
 * google/flatbuffers 25.12.19 release binaries): `flatc` (Linux x86_64),
 * `flatc.exe` (Windows x64) and `flatc-macos` (macOS, universal). A system
 * flatc on PATH is the fallback. Plain Node, so it runs the same on every
 * platform (no bash). Generated code is gitignored and never hand-edited.
 *
 * Note: modern flatc removed the plain `--js` generator; `--ts` is the
 * supported JavaScript/TypeScript path.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VENDORED = {
  "linux-x64": "flatc",
  "win32-x64": "flatc.exe",
  "darwin-x64": "flatc-macos",
  "darwin-arm64": "flatc-macos",
}[`${process.platform}-${process.arch}`];

function runnable(path) {
  try {
    accessSync(path, process.platform === "win32" ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findFlatc() {
  if (VENDORED) {
    const path = join(root, "third_party", "flatc", VENDORED);
    if (existsSync(path) && runnable(path)) return path;
  }
  const r = spawnSync("flatc", ["--version"], { stdio: "ignore" });
  if (r.status === 0) return "flatc";
  console.error(`error: no flatc found for ${process.platform}-${process.arch}.`);
  console.error("Expected a vendored binary in third_party/flatc/, or install flatc 25.12.19 on PATH:");
  console.error("  sudo apt-get install flatbuffers-compiler   # Ubuntu/Debian");
  console.error("  brew install flatbuffers                    # macOS");
  process.exit(1);
}

const flatc = findFlatc();
// Relative to the root (flatc runs there), as the bash script passed them.
const out = process.env.OUT_DIR ?? join("packages", "schema", "generated");
const schema = join("packages", "schema", "mmo_engine.fbs");

for (const [lang, dir] of [["--cpp", "cpp"], ["--ts", "ts"]]) {
  mkdirSync(resolve(root, out, dir), { recursive: true });
  const r = spawnSync(flatc, [lang, "-o", join(out, dir), schema], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`error: ${flatc} ${lang} failed (${r.error?.message ?? r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
const base = resolve(root, out);
walk(base);
console.log(`codegen OK (flatc: ${flatc === "flatc" ? flatc : relative(root, flatc)}):`);
for (const f of files.sort()) console.log(join(out, relative(base, f)).split("\\").join("/"));
