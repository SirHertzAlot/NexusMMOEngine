/**
 * EA19: deploy the local package.
 *
 * Usage: node scripts/deploy-local.mjs [--port <n>]
 *
 * Assembles the package if needed, swaps it into dist/deploy/local
 * (keeping the previous one for rollback), starts the server, and
 * polls /health. On failure the previous package is restored and
 * restarted — a bad deploy never leaves the local target down.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { deployLocal, verifyManifest } from "../packages/build/dist/src/index.js";
import { readFileSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7777;

// Make sure the package exists and is intact.
execSync("node scripts/package.mjs", { cwd: root, stdio: "inherit" });
const pkgDir = join(root, "dist", "package");
const manifest = JSON.parse(readFileSync(join(pkgDir, "manifest.json"), "utf8"));
const v = verifyManifest(pkgDir, manifest);
if (!v.ok) {
  console.error("deploy:local: package manifest FAILED:");
  for (const p of v.problems) console.error("  " + p);
  process.exit(1);
}

const res = await deployLocal(pkgDir, {
  deployDir: join(root, "dist", "deploy", "local"),
  startCommand: `MMO_PORT=${port} node packages/engine-core/dist/src/server.js`,
  healthUrl: `http://127.0.0.1:${port}/health`,
});
if (res.ok) {
  console.log(`deploy:local: up on port ${port} (health: /health)`);
  if (existsSync(join(root, "dist", "deploy", "local.prev"))) {
    console.log("deploy:local: previous package discarded");
  }
} else if (res.rolledBack) {
  console.error("deploy:local: new package failed health; rolled back to the previous package");
  process.exit(2);
} else {
  console.error("deploy:local: new package failed health; nothing to roll back to");
  process.exit(2);
}
// The server is detached: this script exits and leaves it running.
// Stop it via the editor's server controls or by killing the port owner.
process.exit(0);
