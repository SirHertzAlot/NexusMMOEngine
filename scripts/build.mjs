#!/usr/bin/env node
/**
 * `npm run build`: build the whole project, in order.
 *
 *   1. every workspace's own build: the FlatBuffers bindings (codegen), the
 *      TypeScript packages, the edge and the server, and the production
 *      bundles of the player's client and the editor
 *   2. the native addons under packages/addons (node-gyp: a full rebuild
 *      when there is no build yet, else an incremental one)
 *   3. the native entries of the modules under modules/ (`npm run build:native`)
 *
 *   npm run build                  everything
 *   npm run build -- --no-native   steps 2 and 3 skipped (TypeScript and bundles only)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { npm, root, run, win } from "./lib/run.mjs";

const skipNative = process.argv.includes("--no-native");
const log = (msg) => console.log(`[build] ${msg}`);

/** Workspace folders of the root package.json that hold a binding.gyp (the native addons). */
function addonFolders() {
  const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return workspaces.filter((w) => existsSync(join(root, w, "binding.gyp")));
}

/** True when the addon has been built before (a compiled .node under build/Release). */
function built(dir) {
  const out = join(root, dir, "build", "Release");
  return existsSync(out) && readdirSync(out).some((f) => f.endsWith(".node"));
}

npm("build", ["run", "build", "--workspaces", "--if-present"], { hint: "a workspace failed to build; the error is above" });

if (skipNative) {
  log("done (native addons and modules skipped)");
  process.exit(0);
}

const gyp = ["node-gyp"];
for (const dir of addonFolders()) {
  const full = join(root, dir);
  const action = built(dir) ? "build" : "rebuild";
  log(`${dir}: node-gyp ${action}`);
  const status = run("npx", [...gyp, action, "-j", "max"], { cwd: full });
  if (status !== 0) {
    console.error(`[build] ${dir}: node-gyp ${action} failed${win ? " (the Visual Studio C++ build tools and Python are needed)" : " (a C++17 compiler and Python are needed)"}`);
    process.exit(status);
  }
}

npm("build", ["run", "build:native"]);
log("done");
