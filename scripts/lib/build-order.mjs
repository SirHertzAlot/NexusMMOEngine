/**
 * Shared by scripts/build.mjs and scripts/test-prebuild.mjs: the workspaces
 * with a build script, dependencies first (declared ones plus those a script
 * builds first via scripts/dep-build.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./run.mjs";

/** Workspaces with a build script, dependencies first (declared ones plus those a script builds first). */
export function buildOrder() {
  const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pkgs = new Map();
  for (const w of workspaces) {
    const file = join(root, w, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const text = Object.values(pkg.scripts ?? {}).join(" ");
    const deps = new Set([...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), ...text.matchAll(/dep-build\.mjs (\S+)/g)].map((d) => (Array.isArray(d) ? d[1] : d)));
    pkgs.set(pkg.name, { deps, builds: Boolean(pkg.scripts?.build) });
  }
  const order = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !pkgs.has(name)) return;
    seen.add(name);
    for (const d of pkgs.get(name).deps) visit(d);
    if (pkgs.get(name).builds) order.push(name);
  };
  for (const name of pkgs.keys()) visit(name);
  return order;
}
