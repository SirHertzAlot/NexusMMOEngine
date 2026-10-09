/**
 * Package assembly and input hashing for the Release pipeline (EA19, host side).
 *
 * A package is a folder that mirrors the repo's runtime layout, so the
 * server finds its content the way it does in development:
 *
 *   manifest.json   what went in and from which commit
 *   start.mjs       runs the server (and the edge) with env.json
 *   env.json        the profile's environment
 *   packages/ apps/ the built workspaces the server needs (dist only, no sources or tests)
 *   content/ modules/  the game's data; content/modules.json is the profile's module set
 *   data/           the baked world, dungeons and loot
 *   client/         the client's static build, when the profile builds it
 *   node_modules/   links: the package's own workspaces, and the third-party
 *                   dependencies they need, linked from this machine's install
 *
 * Never copied, anywhere: users.csv, SQLite files, editor-login.json, data
 * folders of the workspaces (they hold a developer's world and accounts), and
 * /assets/ (confidential art; a package never contains it).
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BuildProfile, PackageManifest } from "./release-model.js";

// ---- hashing

/** Folders that are output or somebody else's code: never inputs. */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-app", "build", "third_party", "data", "generated", "coverage", ".git", ".release", ".cache"]);
const MAX_HASHED = 5 * 1024 * 1024;

function walk(root: string, visit: (abs: string, rel: string) => void, skip: (name: string, isDir: boolean) => boolean, base = root): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.isSymbolicLink() || skip(e.name, e.isDirectory())) continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) walk(abs, visit, skip, base);
    else visit(abs, relative(base, abs).split(sep).join("/"));
  }
}

/**
 * Hash the files under the given roots (relative to repoRoot): path and content, in a fixed order.
 * `tests: false` leaves out test folders and *.test.* files, for steps that do not read them.
 */
export function hashTree(repoRoot: string, roots: string[], opts: { tests: boolean }): string {
  const h = createHash("sha256");
  const skip = (name: string, isDir: boolean): boolean =>
    isDir ? SKIP_DIRS.has(name) || (!opts.tests && (name === "test" || name === "tests")) : !opts.tests && /\.test\.[cm]?[jt]s$/.test(name);
  for (const r of roots) {
    const abs = join(repoRoot, r);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) {
      h.update(`${r}\0`).update(readFileSync(abs));
      continue;
    }
    walk(abs, (file, rel) => {
      h.update(`${r}/${rel}\0`);
      if (statSync(file).size <= MAX_HASHED) h.update(readFileSync(file));
    }, skip);
  }
  return h.digest("hex");
}

export const hashParts = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

// ---- workspaces

/** Workspace name to its folder (relative to repoRoot), from the root package.json. */
export function workspaceDirs(repoRoot: string): Record<string, string> {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { workspaces?: string[] };
  const out: Record<string, string> = {};
  const add = (dir: string): void => {
    try {
      const p = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as { name?: string };
      if (p.name) out[p.name] = dir;
    } catch {
      /* not a package */
    }
  };
  for (const w of root.workspaces ?? []) {
    if (w.endsWith("/*")) {
      const parent = w.slice(0, -2);
      for (const e of readdirSync(join(repoRoot, parent), { withFileTypes: true })) if (e.isDirectory()) add(`${parent}/${e.name}`);
    } else add(w);
  }
  return out;
}

interface Pkg {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  version?: string;
  main?: string;
}
const readPkg = (dir: string): Pkg | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;
  } catch {
    return null;
  }
};

/** The workspaces the given ones need at run time (dependencies only), the starting ones included. */
export function workspaceClosure(repoRoot: string, start: string[], dirs: Record<string, string>): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const dir = dirs[name];
    if (!dir) throw new Error(`workspace ${name} is not in the repo`);
    seen.add(name);
    for (const dep of Object.keys(readPkg(join(repoRoot, dir))?.dependencies ?? {})) if (dep in dirs) visit(dep);
  };
  start.forEach(visit);
  return [...seen].sort();
}

/** Third-party packages the workspaces need, resolved from the root install (a missing optional one is skipped). */
export function thirdPartyClosure(repoRoot: string, workspaces: string[], dirs: Record<string, string>): Array<{ name: string; version: string }> {
  const out = new Map<string, string>();
  const visit = (name: string, optional: boolean): void => {
    if (out.has(name)) return;
    const pkg = readPkg(join(repoRoot, "node_modules", name));
    if (!pkg) {
      if (optional) return;
      throw new Error(`dependency ${name} is not installed: run npm install`);
    }
    out.set(name, pkg.version ?? "?");
    for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, false);
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) visit(d, true);
  };
  for (const ws of workspaces) {
    const pkg = readPkg(join(repoRoot, dirs[ws]));
    for (const d of Object.keys(pkg?.dependencies ?? {})) if (!(d in dirs)) visit(d, false);
    for (const d of Object.keys(pkg?.optionalDependencies ?? {})) if (!(d in dirs)) visit(d, true);
  }
  return [...out].map(([name, version]) => ({ name, version })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- copying

/** Files that hold a developer's world or accounts, wherever they are. */
export const isPrivateFile = (name: string): boolean => name === "users.csv" || name === "editor-login.json" || /\.db(-wal|-shm|-journal)?$/.test(name);
/** Accounts never travel, not even from the bakes' own folder. */
export const isAccountFile = (name: string): boolean => name === "users.csv" || name === "editor-login.json";

/** What a workspace copy leaves out: sources the build already compiled, tests, native sources, data folders, local databases. */
function packageFilter(srcDir: string): (src: string) => boolean {
  const compiled = existsSync(join(srcDir, "dist")) || existsSync(join(srcDir, "binding.gyp"));
  return (src) => {
    const rel = relative(srcDir, src).split(sep).join("/");
    if (rel === "") return true;
    const top = rel.split("/")[0];
    const name = rel.split("/").pop() as string;
    if (isPrivateFile(name)) return false;
    if (["node_modules", "test", "tests", "third_party", "native", "data", ".git", "dist-app"].includes(top)) return false;
    if (top === "src" && compiled) return false;
    if (top === "dist" && /^dist\/test(\/|$)/.test(rel)) return false;
    if (top === "build") return rel === "build" || rel === "build/Release" || /^build\/Release\/[^/]+\.node$/.test(rel);
    return true;
  };
}

function copyDir(from: string, to: string, filter: (src: string) => boolean): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, filter });
}

function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true });
  // A junction on Windows (no admin needed), a symlink elsewhere.
  symlinkSync(target, at, "junction");
}

/** Count files and bytes under a folder, without following links. */
export function treeSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  walk(dir, (abs) => {
    files++;
    bytes += lstatSync(abs).size;
  }, () => false);
  return { files, bytes };
}

const START_MJS = `// Runs this package: node start.mjs  (env.json holds the profile's settings; MMO_DATA_DIR and MMO_PORT from the environment win)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const env = { ...JSON.parse(readFileSync(join(here, "env.json"), "utf8")), MMO_DATA_DIR: join(here, "data"), ...process.env };
const run = (file, cwd) => spawn(process.execPath, [file], { cwd, env, stdio: "inherit" });
const children = [run(join(here, "packages", "engine-core", "dist", "src", "server.js"), join(here, "packages", "engine-core"))];
if (manifest.edge) children.push(run(join(here, "apps", "edge", "dist", "src", "index.js"), here));
const stop = () => children.forEach((c) => c.kill());
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// One going down takes the others with it.
children.forEach((c) => c.on("exit", (code) => { stop(); process.exitCode ??= code ?? 0; }));
`;

export interface AssembleOptions {
  repoRoot: string;
  /** The package folder to create (replaced if it exists). */
  outDir: string;
  profile: BuildProfile;
  /** The profile's baked data folder (copied to data/). */
  dataDir: string;
  info: { name: string; commit: string; dirty: boolean; builtAt: number; steps: Record<string, string> };
}

/** Build the package folder and write its manifest. */
export function assemblePackage(o: AssembleOptions): PackageManifest {
  const { repoRoot, outDir, profile } = o;
  const dirs = workspaceDirs(repoRoot);
  const workspaces = workspaceClosure(repoRoot, ["@mmo-engine/engine-core", ...(profile.edge ? ["@mmo-engine/edge"] : [])], dirs);
  for (const ws of workspaces) {
    const dir = join(repoRoot, dirs[ws]);
    const main = readPkg(dir)?.main;
    if (main && !existsSync(join(dir, main))) throw new Error(`${ws} is not built (${main} is missing): run the build step first`);
  }
  const third = thirdPartyClosure(repoRoot, workspaces, dirs);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const ws of workspaces) copyDir(join(repoRoot, dirs[ws]), join(outDir, dirs[ws]), packageFilter(join(repoRoot, dirs[ws])));

  // The game's data, with the profile's module set.
  const keep = (src: string): boolean => !isPrivateFile(src.split(sep).pop() as string) && !/[\\/](node_modules|\.git)([\\/]|$)/.test(src);
  copyDir(join(repoRoot, "content"), join(outDir, "content"), keep);
  writeFileSync(join(outDir, "content", "modules.json"), `${JSON.stringify({ modules: profile.modules }, null, 2)}\n`);
  if (existsSync(join(repoRoot, "modules"))) copyDir(join(repoRoot, "modules"), join(outDir, "modules"), keep);
  if (existsSync(o.dataDir)) copyDir(o.dataDir, join(outDir, "data"), (s) => !isAccountFile(s.split(sep).pop() as string));
  else mkdirSync(join(outDir, "data"));
  const clientBuild = join(repoRoot, dirs["@mmo-engine/client"] ?? "apps/client", "dist-app");
  if (profile.build.includes("@mmo-engine/client") && existsSync(clientBuild)) copyDir(clientBuild, join(outDir, "client"), (s) => !/[\\/]assets([\\/]|$)/.test(relative(clientBuild, s)));

  // node_modules: the package's own workspaces, then the third-party closure linked from this install.
  for (const ws of workspaces) link(resolve(outDir, dirs[ws]), join(outDir, "node_modules", ...ws.split("/")));
  for (const t of third) link(resolve(repoRoot, "node_modules", ...t.name.split("/")), join(outDir, "node_modules", ...t.name.split("/")));

  writeFileSync(join(outDir, "env.json"), `${JSON.stringify(profile.env, null, 2)}\n`);
  writeFileSync(join(outDir, "start.mjs"), START_MJS);
  const manifest: PackageManifest = {
    version: 1,
    name: o.info.name,
    profile: profile.name,
    commit: o.info.commit,
    dirty: o.info.dirty,
    builtAt: o.info.builtAt,
    steps: o.info.steps,
    modules: profile.modules,
    env: profile.env,
    edge: profile.edge,
    workspaces,
    thirdParty: third.map((t) => `${t.name}@${t.version}`),
    files: 0,
    bytes: 0,
  };
  const size = treeSize(outDir);
  manifest.files = size.files + 1;
  manifest.bytes = size.bytes;
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
