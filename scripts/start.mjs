#!/usr/bin/env node
/**
 * `npm start`: one command from a fresh clone to a running game. It does
 * whatever setup is missing, then starts the game server, the edge, and
 * the player's client (http://localhost:5173), each line of their output
 * prefixed with its name. Ctrl+C, or any one exiting, stops them all.
 *
 * Setup, each step only when needed (a second start goes straight to the
 * server):
 *   1. dependencies: `npm ci` when node_modules is missing or the lockfile
 *      changed since the last start (npm ci never rewrites the lockfile)
 *   2. FlatBuffers bindings: `npm run codegen` when they're missing or older
 *      than the schema
 *   3. the world: `npm run bake:world` when there's no world.db
 *   4. the loot pool: `npm run loot:bake` when there's no pool.jsonl
 *   5. dungeons: `npm run dungeon:bake` when the dungeon pool is empty
 *   6. the native entries of the modules under modules/: `npm run build:native`
 *      (skips every one already built)
 * With baked towns in the scenes dir (bake:all) and no MMO_SCENE, the server
 * spawns them all plus the places scene (MMO_SCENE=world).
 * The data folder is MMO_DATA_DIR, else packages/engine-core/data, where
 * the server keeps it.
 *
 *   npm start                  setup, the server and the player's client
 *   npm start -- --server      setup and the server only
 *   npm start -- --dev         the server and editor development environment
 *                              (http://localhost:5174)
 *   npm start -- --no-setup    skip the setup checks
 *   npm start -- --build       run the full `npm run build` first
 *   npm start -- --shape=continents   the first bake's landmass shape
 *                              (island, peninsula or continents; only when
 *                              there is no world yet)
 *
 * `npm run dev` is `npm start -- --dev`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { npm as runNpm, root, win } from "./lib/run.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const dev = flag("--dev");
const serverOnly = flag("--server");
const build = flag("--build");
const shape = args.find((a) => a.startsWith("--shape="))?.slice("--shape=".length);

const log = (msg) => console.log(`[start] ${msg}`);

// ---- setup

/** Run an npm command in the foreground; stop everything if it fails. */
function npm(npmArgs, env = {}, hint = "") {
  runNpm("start", npmArgs, { env, hint, again: "fix that and run npm start again" });
}

function setup() {
  // 1. Dependencies. The stamp records the lockfile they were installed from.
  // An install with no stamp (made before npm start existed) is current
  // unless the lockfile is newer than npm's own record of that install, as
  // after a pull that changed it.
  const lockfile = join(root, "package-lock.json");
  const lock = createHash("sha1").update(readFileSync(lockfile)).digest("hex");
  const stamp = join(root, "node_modules", ".mmo-start-lock");
  const installed = join(root, "node_modules", ".package-lock.json");
  const modules = existsSync(join(root, "node_modules"));
  const stale = existsSync(stamp)
    ? readFileSync(stamp, "utf8") !== lock
    : !existsSync(installed) || statSync(installed).mtimeMs < statSync(lockfile).mtimeMs;
  if (!modules || stale) {
    log(modules ? "the lockfile changed: reinstalling" : "installing dependencies (builds the native addons, a few minutes)");
    npm(["ci"], {}, win
      ? "the native addons need the Visual Studio C++ build tools (\"Desktop development with C++\") and Python"
      : "the native addons need a C++17 compiler (build-essential, or Xcode's command line tools) and Python");
  }
  writeFileSync(stamp, lock);

  // 2. FlatBuffers bindings.
  const schema = join(root, "packages", "schema", "mmo_engine.fbs");
  const generated = join(root, "packages", "schema", "generated", "ts", "mmo_engine.ts");
  if (!existsSync(generated) || statSync(generated).mtimeMs < statSync(schema).mtimeMs) npm(["run", "codegen"]);

  // 3-5. Baked data, where the server will look for it.
  const data = resolve(join(root, "packages", "engine-core"), process.env.MMO_DATA_DIR ?? "data");
  if (!existsSync(join(data, "world.db"))) {
    log(`no world in ${data}: baking it`);
    npm(["run", "bake:world"], { MMO_DATA_DIR: data, ...(shape ? { MMO_BAKE_SHAPE: shape } : {}) });
  }
  if (!existsSync(join(data, "loot", "pool.jsonl"))) {
    log("no loot pool: baking it");
    npm(["run", "loot:bake"], { MMO_DATA_DIR: data });
  }
  const dungeons = join(data, "dungeons");
  if (!existsSync(dungeons) || !readdirSync(dungeons).some((f) => f.endsWith(".dungeon.json"))) {
    log("no dungeons: baking 10");
    npm(["run", "dungeon:bake", "--", "--n", "10"], { MMO_DATA_DIR: data });
  }

  // 6. Native module entries (a module's own addon; built ones are skipped).
  npm(["run", "build:native"]);
}

if (!flag("--no-setup")) setup();
if (build) npm(["run", "build"]);

// ---- the server and development surface

// The players' port: the edge serves it and relays it to the region over the
// core channel (E3b), so the region binds no player port of its own.
const GAME_PORT = process.env.MMO_PORT ?? "7777";
// Baked towns (bake:all) in the scenes dir: the server spawns all of them and the places between (MMO_SCENE=world), unless MMO_SCENE says otherwise.
const scenesDir = process.env.MMO_SCENES || process.env.MMO_SCENES_DIR || join(root, "content", "scenes");
const bakedTowns = existsSync(scenesDir) && readdirSync(scenesDir).some((f) => /^settlement-.+\.scene\.json$/.test(f));
const SERVER = { name: "server", args: ["run", "server"], env: { MMO_EDGE: "1", ...(!process.env.MMO_SCENE && bakedTowns ? { MMO_SCENE: "world" } : {}) } };
const EDGE = { name: "edge", args: ["run", "edge"], env: { EDGE_GAME_PORT: GAME_PORT } };
const CLIENT = {
  name: "client",
  args: ["run", "dev", "--workspace=@mmo-engine/client"],
};
const EDITOR = { name: "editor", args: ["run", "dev", "--workspace=@mmo-engine/editor"] };

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) kill(c);
  // Give them a moment to save (the server writes its last tick), then go.
  setTimeout(() => process.exit(code), 3000).unref();
}

/** Stop a child and what it started (npm runs the server under a shell). */
function kill(child) {
  if (win) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // its process group
  } catch {
    child.kill("SIGTERM");
  }
}

/** Run one npm script, its output prefixed; `onLine` sees each line (stdout and stderr). */
function run(p, onLine = () => {}) {
  // npm is npm.cmd on Windows, which needs a shell to run.
  // Each in its own process group (POSIX), so stopping it stops everything under it.
  const child = spawn("npm", p.args, { cwd: root, env: { ...process.env, ...p.env }, stdio: ["ignore", "pipe", "pipe"], shell: win, detached: !win });
  children.push(child);
  const prefix = (stream, out, see) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        out.write(`[${p.name}] ${line}\n`);
        see(line);
      }
    });
    stream.on("end", () => rest && out.write(`[${p.name}] ${rest}\n`));
  };
  prefix(child.stdout, process.stdout, onLine);
  prefix(child.stderr, process.stderr, onLine);
  child.on("exit", (code) => {
    if (!stopping) log(`${p.name} exited (${code ?? "signal"}); stopping the rest`);
    stop(code ?? 0);
  });
}

// The server first: its build compiles the shared packages the client
// needs too. The edge boots once the region is listening on its channel,
// and the client once the edge serves the players' port.
let clientStarted = serverOnly;
let edgeStarted = false;
run(SERVER, (line) => {
  if (edgeStarted || !/listening on/.test(line)) return;
  edgeStarted = true;
  run(EDGE, (edgeLine) => {
    if (clientStarted || !/game port :/.test(edgeLine)) return;
    clientStarted = true;
    run(dev ? EDITOR : CLIENT);
    log(dev ? "open http://localhost:5174 (editor)" : "open http://localhost:5173");
  });
  log(`edge on ws://localhost:${GAME_PORT} (players), http://localhost:3000 (health)`);
});

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
