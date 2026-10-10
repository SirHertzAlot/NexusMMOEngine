/**
 * Editor dev host — a Vite plugin that owns the local play-mode server.
 *
 * Browser code cannot spawn processes, so play mode needs a trusted
 * local host. This plugin (dev-only) adds editor API routes to the Vite
 * dev server:
 *
 *   POST /api/editor/server/start  → spawn `npm run server` (one only)
 *   POST /api/editor/server/stop   → stop ONLY the process we started
 *   GET  /api/editor/server/status → { running, pid?, port? }
 *   GET  /api/editor/terrain       → the heightmap tiles + props around (0,0)
 *   POST /api/editor/terrain/area  → the same for an area {cx, cz, radius}
 *   POST /api/editor/terrain/generate → generator preview (not saved)
 *   POST /api/editor/terrain       → save edited tiles (stops play mode first)
 *   GET  /api/editor/terrain/map   → the whole-world overview (map, regions, spawn)
 *   POST /api/editor/terrain/regenerate → {region} | {area}: re-bake it from
 *                                    the world spec (stops play mode first)
 *   GET  /api/editor/tables        → the gameplay tables (items, creatures,
 *                                    loot, death) + combat's technique ids
 *   POST /api/editor/tables        → save one table {file, json}: validated
 *                                    like the server loads it; 422 + issues
 *                                    when refused (a running server reloads it)
 *   GET  /api/editor/assets        → art-pack scan of <repo>/assets
 *   GET  /assets/*                 → static files from <repo>/assets
 *                                    (path-traversal guarded)
 *   GET  /api/editor/pcg/library   → the PICG asset library: each asset's
 *                                    AssetRef hash and graph parameters (E6)
 *   GET  /api/editor/dungeons      → the baked dungeon pool (E8); /<id> one
 *                                    dungeon and its patch, /<id>/map.png its
 *                                    map, PUT /<id>/patch a validated patch,
 *                                    POST /bake more dungeons (dungeon-host.ts)
 *   GET  /api/editor/pcg/docs      → the PICG graphs and parts (E7)
 *   GET  /api/editor/pcg/doc?file= → one of them
 *   PUT  /api/editor/pcg/doc       → save one {file, doc}: validated with a
 *                                    cook preparation of every graph it
 *                                    affects; 422 + issues when refused
 *   GET  /api/editor/rules         → the rules files (content/rules/*.json)
 *   GET  /api/editor/rules/:name   → one rules file's parsed content
 *   GET/PUT /api/editor/scenes[/:name] → scene documents (scenes-host.ts)
 *   GET/PUT /api/editor/modules, POST /modules/apply → the module set (modules-host.ts)
 *   PUT  /api/editor/rules/:name   → validate (Zod schemas + cross-file
 *                                    checks) then write back pretty-printed;
 *                                    400 with per-path issues when invalid
 *   GET/POST/PUT /api/editor/gameplay[/check|/:table] → the Gameplay data grids (EA15, gameplay-host.ts)
 *   GET  /api/editor/content-catalog → every species, creature, item, prefab, PICG asset, scene, quest (EA15)
 *   GET  /api/editor/story         → the quest and dialog documents (EA20)
 *   GET  /api/editor/story/:name   → one document and the rules references
 *   PUT  /api/editor/story[/:name] → {files} or {content}: validate the whole set, then write; 400
 *                                    with per-path issues writes nothing
 *   POST /api/editor/story/check   → {files} → issues, nothing written
 *   GET  /api/editor/characters    → the account's characters (id, name)
 *                                    from <dataDir>/characters.db (read-only)
 *   GET  /api/editor/characters/:id → one character's record: name, look,
 *                                    deaths, saved state and ledger items
 *                                    (characters.db + world.db, read-only)
 *   GET  /api/editor/build/profiles → build profiles (EA19, build-host.ts)
 *   POST /api/editor/build/run      → {profile}: start a pipeline run (409
 *                                    while one runs)
 *   GET  /api/editor/build/runs     → run history, newest first
 *   GET  /api/editor/build/runs/:id → one run with stage-by-stage status
 *   POST /api/editor/build/deploy   → {port?}: deploy the local target
 *                                    (background; 409 while one runs)
 *   GET  /api/editor/build/deploy/status → the deploy state
 *
 * Safety rules:
 * - At most one owned server at a time; start while running → 409.
 * - stop() kills only the tracked child handle — never a port scan,
 *   never pkill. The child is also killed when Vite exits.
 * - The assets static route normalizes the path and rejects anything
 *   escaping the assets root (403).
 * - Loopback only: /api/editor/* and /assets/* answer 403 to any
 *   non-local client, even if Vite is started with --host. assets/ holds
 *   licensed, confidential art, and play-mode start returns dev
 *   credentials — neither may leave the machine.
 * - Dev only: the plugin logs a loud banner and refuses to install
 *   its routes when NODE_ENV=production.
 */

import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, posix, resolve, sep, win32 } from "node:path";
import {
  isRuleFile,
  readRuleFile,
  ruleFileNames,
  saveRuleFile,
} from "./rules-host.js";
import { handleScenesRoute } from "./scenes-host.js";
import { handleFlowRoute } from "./flow-host.js";
import { handleContentRoute, playSceneEnv, type PlaySceneRequest } from "./scene-play.js";
import { handleVcsRoute } from "./vcs-host.js";
import { handleGameplayRoute } from "./gameplay-routes.js";
import { handleModulesRoute, parseTickOrder } from "./modules-host.js";
import { checkStory, isStoryFile, readStoryFile, saveStoryFiles, storyFileNames } from "./story-host.js";
import { pathToFileURL } from "node:url";
import { handleDatabase, openDatabaseCore, portOpen, type DatabaseCore } from "./database-host.js";
import { isEditableTable, readRulesTables, saveRulesTable } from "./rules-store.js";
import { listPcgDocuments, readPcgDocument, readPcgLibrary, savePcgDocument } from "./pcg-host.js";
import { ARCHETYPES, listPool, mapPng, readDungeon, runBake, savePatch } from "./dungeon-host.js";
import { createBuildHost, createLocalDeployer, loadProfiles } from "./build-host.js";
import { runProfile } from "@mmo-engine/build";
import { backupWorld, discardBackup, restoreWorld } from "@mmo-engine/engine-core";

/** True for connections from this machine (IPv4, IPv6, IPv4-mapped IPv6). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * How to run `npm <args>`: the SAME npm and Node that launched the editor.
 * `npm run dev` sets npm_execpath to its npm-cli.js, so run it under
 * process.execPath — no PATH lookup, no shell. Resolving "npm" by name is
 * wrong on Windows: without a shell it skips npm.cmd and can hit another
 * install's npm.exe shim (e.g. nvm's), whose Node would not match the ABI
 * of the native addons; npm.cmd itself needs a shell (EINVAL otherwise).
 */
export function npmInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): { command: string; args: string[]; shell: boolean } {
  const cli = env.npm_execpath;
  // The target platform's path rules, not the host's: a Windows path has
  // no "/" separators, so POSIX basename would return all of it.
  const { basename } = platform === "win32" ? win32 : posix;
  if (cli && basename(cli) === "npm-cli.js") {
    return { command: execPath, args: [cli, ...args], shell: false };
  }
  // Fallback (editor not started through npm). npm.cmd needs a shell on
  // Windows; the args are fixed literals, so one pre-joined command line
  // is safe (and avoids Node's DEP0190 args-with-shell warning).
  return platform === "win32"
    ? { command: ["npm.cmd", ...args].join(" "), args: [], shell: true }
    : { command: "npm", args, shell: false };
}

/**
 * Terminate a process tree we spawned. POSIX: signal the detached
 * process group (negative pid). Windows has no process groups or
 * catchable signals, so `taskkill /T /F` ends the whole tree
 * (npm → cmd → node) — `process.kill(-pid)` would throw there and leave
 * the real server orphaned on the port.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (pid <= 0) return;
  try {
    if (platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    /* already gone */
  }
}

/** Whether any process of the tree is still alive (best effort). */
function treeAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EditorHostOptions {
  /** Repo root — the server workspace and the assets/ dir live here. */
  repoRoot: string;
  /** Port for the spawned game server (MMO_PORT). Default 7777. */
  serverPort?: number;
  /** How long to wait for the server's "listening" line. Default 120s. */
  readyTimeoutMs?: number;
  /**
   * The world the editor plays and edits: world.db, users.csv, navmesh/.
   * Default <repo>/packages/engine-core/data — the same world
   * `npm run server` runs, so terrain edited here is the terrain players get.
   */
  dataDir?: string;
}

/** Terrain save/load payloads are ~2-10 KB per chunk as JSON. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface OwnedServer {
  child: ChildProcess;
  pid: number;
  port: number;
  url: string;
  /** One-session dev credentials seeded for this server (see below). */
  username: string;
  password: string;
  /** Logins for the Play menu's extra (headless) clients; same password. */
  loadUsers: string[];
  /** The tick order the server reported at boot (Modules window). */
  tickOrder(): string[] | null;
}

const LISTEN_RE = /listening on ws:\/\/[^:]+:(\d+)/;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** One read per request: a second call gets the same body instead of waiting on a stream that already ended. */
const bodies = new WeakMap<IncomingMessage, Promise<string>>();

export function readBody(req: IncomingMessage): Promise<string> {
  const known = bodies.get(req);
  if (known) return known;
  const read = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  bodies.set(req, read);
  return read;
}

/** How many extra clients the Play menu can ask for (8 clients = the play login + 7). */
export const MAX_LOAD_CLIENTS = 7;

/**
 * The logins the Play menu's extra clients use, derived from the play
 * login. Each client needs its own account: two sessions of one account
 * enter as the same character, and the newer one evicts the older (it
 * would kick the game view's client). Usernames stay within 32 chars.
 */
export function editorLoadUsers(username: string, n = MAX_LOAD_CLIENTS): string[] {
  return Array.from({ length: n }, (_, i) => `${username.slice(0, 26)}-load${i + 1}`);
}

/**
 * The editor's dev login for play mode: created once per world and reused,
 * stored beside users.csv in the (git-ignored) data dir. Seeding a fresh
 * random account on every Play would add a users.csv row per run.
 */
function editorLogin(dataDir: string): { username: string; password: string } {
  const file = join(dataDir, "editor-login.json");
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { username?: unknown; password?: unknown };
    if (typeof saved.username === "string" && typeof saved.password === "string") {
      return { username: saved.username, password: saved.password };
    }
  } catch {
    /* first run, or unreadable: create a new one */
  }
  const login = {
    username: `editor-${randomBytes(4).toString("hex")}`,
    password: randomBytes(16).toString("hex"),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(login), { mode: 0o600 });
  return login;
}

/**
 * Character record view (roadmap E10): read-only gathers over the editor's
 * world. The data-gathering lives in the engine
 * (`packages/engine-core/src/characters/character-view.ts`, SELECT-only);
 * this host only opens the two databases read-only, resolves loot-pool
 * definition names, and serves the JSON. Nothing here writes.
 */

interface ReadonlyDb {
  close(): void;
}

/** Open a SQLite file read-only (a running server keeps writing beside us). */
async function openReadOnlyDb(file: string): Promise<ReadonlyDb> {
  let ctor: new (file: string, opts?: { readonly?: boolean }) => ReadonlyDb;
  try {
    const sqlite = (await import("better-sqlite3")) as unknown as {
      default: new (file: string, opts?: { readonly?: boolean }) => ReadonlyDb;
    };
    ctor = sqlite.default;
  } catch {
    throw Object.assign(new Error("better-sqlite3 unavailable — run npm install"), { status: 500 });
  }
  return new ctor(file, { readonly: true });
}

interface CharacterViewModule {
  listCharacters(db: unknown, username?: string): Array<{ id: number; username: string; name: string }>;
  readCharacterView(
    db: unknown,
    username: string,
    id: number,
    opts: { worldDb?: unknown; defs?: unknown },
  ): unknown;
}

/** The built data-gathering module, imported by file (never bundled). */
async function loadCharacterViewModule(repoRoot: string): Promise<CharacterViewModule> {
  const file = join(repoRoot, "packages", "engine-core", "dist", "src", "characters", "character-view.js");
  if (!existsSync(file)) {
    throw Object.assign(
      new Error("character view not built — run: npm run build --workspace=@mmo-engine/engine-core"),
      { status: 500 },
    );
  }
  return (await import(pathToFileURL(file).href)) as unknown as CharacterViewModule;
}

/**
 * Loot-pool definition names by def index (the ledger stores indices).
 * Definition order follows the pool file order (ItemDefs builds them in
 * order), so line n is def n. Null when there is no baked pool: rows show
 * `def <n>` placeholders instead.
 */
function loadPoolDefNames(dataDir: string): { count: number; names: string[]; ranks: string[]; colors: string[] } | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, "loot", "pool.jsonl"), "utf8");
  } catch {
    return null;
  }
  const names: string[] = [];
  const ranks: string[] = [];
  const colors: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const it = JSON.parse(t) as {
        rank?: unknown;
        bundle?: { Identity?: { name?: unknown }; Rank?: { color?: unknown } };
      };
      names.push(typeof it.bundle?.Identity?.name === "string" ? it.bundle.Identity.name : "?");
      ranks.push(typeof it.rank === "string" ? it.rank : "");
      colors.push(typeof it.bundle?.Rank?.color === "string" ? it.bundle.Rank.color : "");
    } catch {
      /* skip a bad line */
    }
  }
  return { count: names.length, names, ranks, colors };
}

export function editorHost(options: EditorHostOptions): Plugin {
  const repoRoot = resolve(options.repoRoot);
  const serverPort = options.serverPort ?? 7777;
  // `npm run server` rebuilds five packages before listening (~27 s measured
  // on Windows), so 30 s left almost no margin.
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const assetsRoot = join(repoRoot, "assets");
  const dataDir = resolve(options.dataDir ?? join(repoRoot, "packages", "engine-core", "data"));
  const rulesDir = join(repoRoot, "content", "rules");
  let owned: OwnedServer | null = null;
  /** Snapshot bookkeeping for the Play menu's fresh/keep options. */
  let snapshotActive = false;
  let snapshotKeep = false;
  let dbCore: DatabaseCore | null = null;

  // EA19 build pipeline: profiles, background runs, local deploy.
  const buildHost = createBuildHost({
    rootDir: repoRoot,
    profiles: loadProfiles(repoRoot, (msg) => console.warn(`[editor-host] ${msg}`)),
    runner: (rootDir, profile, onStage) => runProfile(rootDir, profile, { onStage }).then(() => {}),
    deployer: createLocalDeployer(repoRoot),
  });

  /**
   * Run the engine's terrain tool (export | generate | import | map | regenerate) as its own
   * process — native SQLite/procgen code never loads into Vite — with the
   * editor's world as MMO_DATA_DIR. Resolves with its JSON output; a
   * failure rejects with the tool's message.
   */
  function runTerrainTool(cmd: "export" | "generate" | "import" | "map" | "regenerate", input?: string): Promise<unknown> {
    const tool = join(repoRoot, "packages", "engine-core", "dist", "src", "terrain-tool.js");
    if (!existsSync(tool)) {
      return Promise.reject(
        new Error("terrain tool not built — run: npm run build --workspace=@mmo-engine/engine-core"),
      );
    }
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [tool, cmd], {
        cwd: repoRoot,
        env: { ...process.env, MMO_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectRun(new Error(`terrain ${cmd} timed out`));
        // A regenerate re-runs the world survey (~10 s for 4 km) first.
      }, cmd === "regenerate" ? 300_000 : 60_000);
      timer.unref?.();
      child.on("error", (e) => {
        clearTimeout(timer);
        rejectRun(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          try {
            resolveRun(JSON.parse(out));
          } catch {
            rejectRun(new Error(`terrain ${cmd}: unreadable tool output`));
          }
        } else {
          const message = err.trim().split("\n").pop() || `terrain ${cmd} failed (exit ${code})`;
          // A running server owns the world: that's a conflict, not a bug.
          rejectRun(Object.assign(new Error(message), { status: /is running/.test(message) ? 409 : 400 }));
        }
      });
      child.stdin?.end(input ?? "");
    });
  }

  async function stopOwned(): Promise<boolean> {
    if (!owned) return false;
    const child = owned.child;
    owned = null;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    // The child leads its own process tree (see startOwned): `npm run
    // server` spawns shell → node grandchildren, so killing just the npm
    // wrapper would orphan the real server. killProcessTree ends the
    // whole tree — still only ever OUR tree.
    const pid = child.pid ?? -1;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcessTree(pid, "SIGKILL");
      }, 5000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      // POSIX: SIGTERM lets the server run its shutdown save. Windows
      // has no catchable SIGTERM, so this is a hard stop there; the
      // periodic save (every 300 ticks) bounds what play mode loses.
      killProcessTree(pid, "SIGTERM");
      // If the tree is already gone, the exit event may never fire.
      setTimeout(() => {
        if (!treeAlive(pid)) {
          clearTimeout(timer);
          resolve();
        }
      }, 500).unref();
    });
    return true;
  }

  async function startOwned(opts?: { bots?: number; scene?: PlaySceneRequest }): Promise<OwnedServer> {
    if (owned) {
      throw Object.assign(new Error("a play-mode server is already running"), {
        status: 409,
      });
    }
    // One explicit data dir for the whole play-mode session: the server
    // resolves users.csv (and world.db) from MMO_DATA_DIR, and the seed
    // below writes to the same file. Seeding happens BEFORE the server
    // starts because the gateway's CsvCredentialStore loads the CSV once
    // at startup — users added afterwards would not be visible.
    // EA6: the open scene (validated before anything starts; may be unsaved).
    const sceneEnv = playSceneEnv(repoRoot, dataDir, opts?.scene);
    const usersCsv = join(dataDir, "users.csv");
    const { username, password } = editorLogin(dataDir);
    const loadUsers = editorLoadUsers(username);
    // Dev-only local credential: the plaintext goes to the browser over
    // localhost only and is never logged; users.csv stores only the
    // argon2id hash. seed-user is idempotent: it creates the account on
    // first use and does nothing once it exists.
    await new Promise<void>((resolveSeed, rejectSeed) => {
      // process.execPath, not "node" from PATH: seed-user loads argon2
      // (native), which must match the Node the repo was built with.
      const seed = spawn(
        process.execPath,
        [
          "packages/engine-core/dist/src/auth/seed-user.js",
          "--csv",
          usersCsv,
          username,
          ...loadUsers,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, MMO_DEV_PASSWORD: password },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let errOut = "";
      seed.stderr?.on("data", (d: Buffer) => {
        errOut += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        try {
          seed.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        rejectSeed(new Error("seed-user timed out"));
      }, 60_000);
      timer.unref?.();
      seed.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolveSeed();
        else
          rejectSeed(
            new Error(`seed-user exited ${code}: ${errOut.slice(-500)}`),
          );
      });
      seed.on("error", (err) => {
        clearTimeout(timer);
        rejectSeed(err);
      });
    });

    // Play runs the built server directly: `npm run server` rebuilds every
    // workspace first (minutes), and the --silent output hid that wait.
    // MMO_EDITOR_REBUILD=1 (or no build yet) takes the npm path instead.
    const serverJs = join(repoRoot, "packages", "engine-core", "dist", "src", "server.js");
    const npm =
      process.env.MMO_EDITOR_REBUILD !== "1" && existsSync(serverJs)
        ? { command: process.execPath, args: [serverJs], shell: false }
        : npmInvocation(["run", "server", "--workspace=@mmo-engine/engine-core", "--silent"]);
    const child = spawn(npm.command, npm.args, {
      cwd: npm.shell || npm.args[0] !== serverJs ? repoRoot : join(repoRoot, "packages", "engine-core"),
      env: {
        ...process.env,
        MMO_PORT: String(serverPort),
        MMO_DATA_DIR: dataDir,
        // The Play menu's Bots choice, when the start request carries it.
        ...(opts?.bots !== undefined ? { MMO_BOTS: String(opts.bots) } : {}),
        ...sceneEnv,
        // The debugger's admin console (E5): the editor's own play user is
        // an admin of the server it owns, on top of any configured ones.
        MMO_ADMINS: [process.env.MMO_ADMINS, username].filter(Boolean).join(","),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: npm.shell,
      // Detached: on POSIX the npm → sh → node chain becomes its own
      // process GROUP, so stopOwned() can signal the group and the real
      // server is never orphaned by killing just the wrapper.
      detached: true,
      // Windows: detached would otherwise open a console window.
      windowsHide: true,
    });
    // Don't keep the vite host alive for the child; the host "exit" hook
    // below still cleans the owned group up on dev-server shutdown.
    child.unref();
    const pid = child.pid ?? -1;
    let output = "";
    let bootOrder: string[] | null = null;
    const onData = (d: Buffer): void => {
      output += d.toString("utf8");
      bootOrder ??= parseTickOrder(output);
      if (output.length > 64_000) output = output.slice(-64_000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => {
      if (owned?.child === child) owned = null;
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        void stopOwned();
        reject(
          new Error(
            `play-mode server did not report listening within ${readyTimeoutMs}ms.\n` +
              `Last output:\n${output.slice(-2000)}`,
          ),
        );
      }, readyTimeoutMs);
      timer.unref?.();
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(
          new Error(
            `play-mode server exited during startup (code ${code}).\n` +
              `Output:\n${output.slice(-2000)}`,
          ),
        );
      };
      const check = (d: Buffer): void => {
        const m = LISTEN_RE.exec(d.toString("utf8"));
        if (m) {
          cleanup();
          resolve(`ws://127.0.0.1:${m[1]}`);
        }
      };
      child.on("exit", onExit);
      child.stdout?.on("data", check);
      child.stderr?.on("data", check);
    });

    // Track the child IMMEDIATELY (before the ready wait can time out),
    // so a startup timeout can still kill the group via stopOwned().
    owned = {
      child,
      pid,
      port: serverPort,
      url: `ws://127.0.0.1:${serverPort}`,
      username,
      password,
      loadUsers,
      tickOrder: () => bootOrder,
    };
    // Adopt the actual bound port from the server's listen line once
    // ready (normally identical to serverPort).
    owned.url = url;
    return owned;
  }

  async function assetScan(): Promise<Record<string, unknown>> {
    try {
      const art = (await import("@mmo-engine/art")) as {
        scanAssetDir(root: string): {
          manifest: unknown;
          diagnostics: string[];
        };
      };
      if (existsSync(assetsRoot)) {
        return { root: assetsRoot, ...art.scanAssetDir(assetsRoot) };
      }
      return {
        root: assetsRoot,
        manifest: null,
        diagnostics: [
          `assets/ directory not found at ${assetsRoot} — ` +
            "create it and add models/ + textures/ (see docs/EDITOR.md).",
        ],
      };
    } catch (err) {
      return {
        root: assetsRoot,
        manifest: null,
        diagnostics: [
          `asset scan unavailable: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  function serveAssetFile(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const rel = urlPath.replace(/^\/assets\//, "");
    const abs = normalize(join(assetsRoot, rel));
    if (abs !== assetsRoot && !abs.startsWith(assetsRoot + sep)) {
      sendJson(res, 403, { ok: false, error: "path escapes assets root" });
      return;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    const mime: Record<string, string> = {
      glb: "model/gltf-binary",
      gltf: "model/gltf+json",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      json: "application/json",
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", mime[ext] ?? "application/octet-stream");
    createReadStream(abs).pipe(res);
  }

  return {
    name: "mmo-editor-host",
    configureServer(server: ViteDevServer) {
      if (process.env.NODE_ENV === "production") {
        server.config.logger.warn(
          "[mmo-editor-host] refusing to install dev routes in production",
        );
        return;
      }
      console.log(
        "[mmo-editor-host] DEV ONLY — local play-mode server control at /api/editor/*",
      );
      const exitHandler = (): void => {
        if (owned) {
          // Tree kill — matches the detached spawn in startOwned().
          // Synchronous on every platform, as an "exit" handler must be.
          killProcessTree(owned.child.pid ?? -1, "SIGKILL");
          owned = null;
        }
      };
      process.once("exit", exitHandler);
      // Vite closes this HTTP server on shutdown AND on every dev-server
      // restart (e.g. editing vite.config.ts or this file). The restarted
      // plugin instance starts with owned = null and could never stop a
      // server spawned here — it would hold the port as an orphan. Stop it
      // now, and drop this instance's exit hook so restarts don't pile
      // listeners up.
      server.httpServer?.once("close", () => {
        process.off("exit", exitHandler);
        void stopOwned();
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (
          (url.startsWith("/api/editor/") || url.startsWith("/assets/")) &&
          !isLoopbackAddress(req.socket.remoteAddress)
        ) {
          sendJson(res, 403, { ok: false, error: "editor routes are local-only" });
          return;
        }
        try {
          if (url === "/api/editor/server/start" && req.method === "POST") {
            const startBody = await readBody(req);
            // Start options honored today: bots → MMO_BOTS, the optional
            // {scene: {name, content?}} for playing the open scene (EA6),
            // and fresh/keep for world snapshot/restore.
            // Anything else in the body is ignored (the Play menu badges
            // those dimensions "preview" instead of pretending).
            let bots: number | undefined;
            let scene: PlaySceneRequest | undefined;
            let fresh = false;
            let keep = false;
            try {
              const parsed = JSON.parse(startBody || "{}") as { bots?: unknown; scene?: PlaySceneRequest; fresh?: unknown; keep?: unknown };
              if (typeof parsed.bots === "number" && Number.isFinite(parsed.bots) && parsed.bots >= 0) {
                bots = Math.floor(parsed.bots);
              }
              scene = parsed.scene;
              fresh = parsed.fresh === true;
              keep = parsed.keep === true;
            } catch {
              /* empty / non-JSON body: server defaults */
            }
            // Fresh state: back up world.db before the server starts.
            if (fresh) {
              backupWorld(join(dataDir, "world.db"));
              snapshotActive = true;
              snapshotKeep = keep;
            }
            const s = await startOwned(bots !== undefined || scene !== undefined ? { bots, scene } : undefined);
            sendJson(res, 200, {
              ok: true,
              pid: s.pid,
              port: s.port,
              url: s.url,
              username: s.username,
              // Dev-only, one-session credential over localhost (see
              // startOwned). Never logged; only the hash is persisted.
              password: s.password,
              loadUsers: s.loadUsers,
            });
            return;
          }
          if (url === "/api/editor/server/stop" && req.method === "POST") {
            await readBody(req);
            const stopped = await stopOwned();
            // Fresh/keep: restore the backup unless keeping play changes.
            if (snapshotActive) {
              const dbPath = join(dataDir, "world.db");
              if (snapshotKeep) {
                discardBackup(dbPath);
              } else {
                restoreWorld(dbPath);
              }
              snapshotActive = false;
              snapshotKeep = false;
            }
            sendJson(res, 200, { ok: true, stopped });
            return;
          }
          if (url === "/api/editor/server/status" && req.method === "GET") {
            sendJson(res, 200, {
              running: owned !== null,
              pid: owned?.pid,
              port: owned?.port,
            });
            return;
          }
          if (url === "/api/editor/terrain" && req.method === "GET") {
            sendJson(res, 200, { ok: true, dataDir, ...(await runTerrainTool("export")) as object });
            return;
          }
          if (url === "/api/editor/terrain/area" && req.method === "POST") {
            const body = await readBody(req);
            sendJson(res, 200, { ok: true, dataDir, ...(await runTerrainTool("export", body)) as object });
            return;
          }
          if (url === "/api/editor/terrain/generate" && req.method === "POST") {
            const body = await readBody(req);
            sendJson(res, 200, { ok: true, ...(await runTerrainTool("generate", body)) as object });
            return;
          }
          if (url === "/api/editor/terrain/map" && req.method === "GET") {
            sendJson(res, 200, { ok: true, ...(await runTerrainTool("map")) as object });
            return;
          }
          if (url === "/api/editor/terrain/regenerate" && req.method === "POST") {
            const body = await readBody(req);
            const stoppedPlayMode = await stopOwned();
            sendJson(res, 200, { ok: true, stoppedPlayMode, ...(await runTerrainTool("regenerate", body)) as object });
            return;
          }
          if (url === "/api/editor/terrain" && req.method === "POST") {
            const body = await readBody(req);
            // A running server would overwrite the edit with its next
            // periodic save. Our own play-mode server is stopped for you;
            // an external one makes the tool refuse (409) with its pid.
            const stoppedPlayMode = await stopOwned();
            sendJson(res, 200, {
              ok: true,
              stoppedPlayMode,
              ...(await runTerrainTool("import", body)) as object,
            });
            return;
          }
          if (url === "/api/editor/tables" && req.method === "GET") {
            sendJson(res, 200, { ok: true, ...readRulesTables(rulesDir) });
            return;
          }
          if (url === "/api/editor/tables" && req.method === "POST") {
            const body = JSON.parse(await readBody(req)) as { file?: unknown; json?: unknown };
            if (!isEditableTable(body.file)) {
              sendJson(res, 400, { ok: false, error: `not an editable rules table: ${String(body.file)}` });
              return;
            }
            const saved = saveRulesTable(rulesDir, body.file, body.json);
            sendJson(res, saved.ok ? 200 : 422, saved);
            return;
          }
          if (url === "/api/editor/assets" && req.method === "GET") {
            sendJson(res, 200, { ok: true, ...(await assetScan()) });
            return;
          }
          const charactersRoute =
            url === "/api/editor/characters" ||
            url.startsWith("/api/editor/characters?") ||
            url.startsWith("/api/editor/characters/");
          if (charactersRoute && req.method === "GET") {
            const parsed = new URL(req.url ?? "/", "http://localhost");
            const parts = parsed.pathname.split("/").filter(Boolean);
            const charsDbPath = join(dataDir, "characters.db");
            if (!existsSync(charsDbPath)) {
              if (parts.length === 3) {
                sendJson(res, 200, { ok: true, characters: [], hasDb: false });
              } else {
                sendJson(res, 404, { ok: false, error: "no characters.db yet — create a character first" });
              }
              return;
            }
            const view = await loadCharacterViewModule(repoRoot);
            if (parts.length === 3) {
              const username = parsed.searchParams.get("username") ?? undefined;
              const db = await openReadOnlyDb(charsDbPath);
              try {
                sendJson(res, 200, {
                  ok: true,
                  hasDb: true,
                  characters: view.listCharacters(db, username || undefined),
                });
              } finally {
                db.close();
              }
              return;
            }
            if (parts.length === 4) {
              const username = parsed.searchParams.get("username") ?? "";
              const id = /^\d{1,10}$/.test(parts[3] ?? "") ? Number(parts[3]) : NaN;
              if (!username || !Number.isSafeInteger(id)) {
                sendJson(res, 400, { ok: false, error: "need ?username= and a numeric id" });
                return;
              }
              const db = await openReadOnlyDb(charsDbPath);
              try {
                const worldDbPath = join(dataDir, "world.db");
                const worldDb = existsSync(worldDbPath) ? await openReadOnlyDb(worldDbPath) : null;
                try {
                  const defs = loadPoolDefNames(dataDir);
                  const record = view.readCharacterView(db, username, id, { worldDb, defs });
                  if (!record) {
                    sendJson(res, 404, { ok: false, error: "no such character for that account" });
                    return;
                  }
                  sendJson(res, 200, {
                    ok: true,
                    view: record,
                    defsResolved: defs !== null,
                    hasWorldDb: worldDb !== null,
                  });
                } finally {
                  worldDb?.close();
                }
              } finally {
                db.close();
              }
              return;
            }
            sendJson(res, 404, { ok: false, error: "not found" });
            return;
          }
          if (url === "/api/editor/dungeons" && req.method === "GET") {
            sendJson(res, 200, { ok: true, dungeons: listPool(dataDir), archetypes: ARCHETYPES });
            return;
          }
          if (url === "/api/editor/dungeons/bake" && req.method === "POST") {
            let body: unknown;
            try {
              body = JSON.parse((await readBody(req)) || "{}") as unknown;
            } catch {
              sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
              return;
            }
            sendJson(res, 200, { ok: true, ...(await runBake(repoRoot, dataDir, (body ?? {}) as object)) });
            return;
          }
          // EA19 build pipeline (build-host.ts).
          if (url === "/api/editor/build/profiles" && req.method === "GET") {
            sendJson(res, 200, { ok: true, profiles: buildHost.listProfiles() });
            return;
          }
          if (url === "/api/editor/build/run" && req.method === "POST") {
            let body: unknown;
            try {
              body = JSON.parse((await readBody(req)) || "{}") as unknown;
            } catch {
              sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
              return;
            }
            const profile = (body as { profile?: unknown }).profile;
            if (typeof profile !== "string" || !profile) {
              sendJson(res, 400, { ok: false, error: "body.profile must be a profile name" });
              return;
            }
            try {
              const rec = buildHost.startRun(profile);
              sendJson(res, 200, { ok: true, run: rec });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const code = /already running/.test(msg) ? 409 : 400;
              sendJson(res, code, { ok: false, error: msg });
            }
            return;
          }
          if (url === "/api/editor/build/runs" && req.method === "GET") {
            sendJson(res, 200, { ok: true, runs: buildHost.listRuns() });
            return;
          }
          {
            const m = /^\/api\/editor\/build\/runs\/([^/?]+)$/.exec(url);
            if (m && req.method === "GET") {
              const rec = buildHost.getRun(m[1]!);
              if (!rec) sendJson(res, 404, { ok: false, error: "unknown run" });
              else sendJson(res, 200, { ok: true, run: rec });
              return;
            }
          }
          if (url === "/api/editor/build/deploy" && req.method === "POST") {
            let body: unknown;
            try {
              body = JSON.parse((await readBody(req)) || "{}") as unknown;
            } catch {
              sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
              return;
            }
            const port = (body as { port?: unknown }).port;
            if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
              sendJson(res, 400, { ok: false, error: "body.port must be a TCP port" });
              return;
            }
            try {
              const state = buildHost.startDeploy(port ?? 7777);
              sendJson(res, 200, { ok: true, deploy: state });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const code = /already running/.test(msg) ? 409 : 400;
              sendJson(res, code, { ok: false, error: msg });
            }
            return;
          }
          if (url === "/api/editor/build/deploy/status" && req.method === "GET") {
            sendJson(res, 200, { ok: true, deploy: buildHost.getDeploy() });
            return;
          }
          // EA23 HUD layout (hud-editor-logic.ts).
          if (url === "/api/editor/hud/layout" && req.method === "GET") {
            const file = join(repoRoot, "content", "ui", "hud.json");
            if (!existsSync(file)) {
              sendJson(res, 404, { ok: false, error: "no hud.json (content/ui/hud.json)" });
              return;
            }
            try {
              sendJson(res, 200, { ok: true, layout: JSON.parse(readFileSync(file, "utf8")) });
            } catch {
              sendJson(res, 500, { ok: false, error: "hud.json is not valid JSON" });
            }
            return;
          }
          if (url === "/api/editor/hud/layout" && req.method === "PUT") {
            let body: unknown;
            try {
              body = JSON.parse((await readBody(req)) || "{}") as unknown;
            } catch {
              sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
              return;
            }
            const layout = (body as { layout?: unknown }).layout;
            if (!layout || typeof layout !== "object") {
              sendJson(res, 400, { ok: false, error: "body.layout must be a HUD layout" });
              return;
            }
            // Basic shape check; the client validates fully on load.
            const widgets = (layout as { widgets?: unknown }).widgets;
            if (!widgets || typeof widgets !== "object") {
              sendJson(res, 400, { ok: false, error: "layout.widgets must be an object" });
              return;
            }
            const file = join(repoRoot, "content", "ui", "hud.json");
            mkdirSync(join(repoRoot, "content", "ui"), { recursive: true });
            writeFileSync(file, JSON.stringify(layout, null, 2) + "\n");
            sendJson(res, 200, { ok: true });
            return;
          }
          const dungeonRoute = /^\/api\/editor\/dungeons\/([^/?]+)(\/map\.png|\/patch)?$/.exec(url);
          if (dungeonRoute) {
            const id = dungeonRoute[1];
            if (!dungeonRoute[2] && req.method === "GET") {
              sendJson(res, 200, { ok: true, ...readDungeon(dataDir, id) });
              return;
            }
            if (dungeonRoute[2] === "/map.png" && req.method === "GET") {
              const png = mapPng(dataDir, id);
              res.statusCode = 200;
              res.setHeader("Content-Type", "image/png");
              res.end(png);
              return;
            }
            if (dungeonRoute[2] === "/patch" && req.method === "PUT") {
              let body: { patch?: unknown };
              try {
                body = JSON.parse(await readBody(req)) as { patch?: unknown };
              } catch {
                sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
                return;
              }
              try {
                sendJson(res, 200, { ok: true, ...savePatch(dataDir, id, body.patch) });
              } catch (err) {
                const issues = (err as { issues?: unknown }).issues;
                sendJson(res, (err as { status?: number }).status ?? 500, {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                  ...(Array.isArray(issues) ? { issues } : {}),
                });
              }
              return;
            }
          }
          if (url === "/api/editor/pcg/library" && req.method === "GET") {
            sendJson(res, 200, { ok: true, ...readPcgLibrary(repoRoot) });
            return;
          }
          if (url === "/api/editor/pcg/docs" && req.method === "GET") {
            sendJson(res, 200, { ok: true, docs: listPcgDocuments(repoRoot) });
            return;
          }
          if (url.startsWith("/api/editor/pcg/doc?") && req.method === "GET") {
            const file = new URL(url, "http://localhost").searchParams.get("file") ?? "";
            sendJson(res, 200, { ok: true, ...readPcgDocument(repoRoot, file) });
            return;
          }
          if (url === "/api/editor/pcg/doc" && req.method === "PUT") {
            let body: { file?: unknown; doc?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as { file?: unknown; doc?: unknown };
            } catch {
              sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
              return;
            }
            if (typeof body.file !== "string" || body.doc === undefined) {
              sendJson(res, 400, { ok: false, error: 'need a JSON body shaped like {"file": …, "doc": …}' });
              return;
            }
            try {
              savePcgDocument(repoRoot, body.file, body.doc);
            } catch (err) {
              const issues = (err as { issues?: unknown }).issues;
              sendJson(res, (err as { status?: number }).status ?? 500, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                ...(Array.isArray(issues) ? { issues } : {}),
              });
              return;
            }
            sendJson(res, 200, { ok: true, file: body.file });
            return;
          }
          if (url.startsWith("/assets/") && req.method === "GET") {
            serveAssetFile(req, res);
            return;
          }
          const contentReply = handleContentRoute(repoRoot, req.method ?? "GET", new URL(req.url ?? "/", "http://localhost").pathname);
          if (contentReply) {
            sendJson(res, contentReply.status, contentReply.body);
            return;
          }
          const modulesUrl = new URL(req.url ?? "/", "http://localhost");
          const modulesReply = await handleModulesRoute(
            repoRoot,
            req.method ?? "GET",
            modulesUrl.pathname,
            req.method === "PUT" ? await readBody(req) : undefined,
            {
              running: () => owned?.tickOrder() ?? null,
              // "Apply modules": the server reads the set at boot, so a running one restarts.
              apply: async () => {
                if (!owned) return { restarted: false };
                await stopOwned();
                const s = await startOwned();
                return { restarted: true, pid: s.pid, port: s.port, url: s.url, username: s.username, password: s.password };
              },
            },
          );
          if (modulesReply) {
            sendJson(res, modulesReply.status, modulesReply.body);
            return;
          }
          const scenesUrl = new URL(req.url ?? "/", "http://localhost");
          const flowReply = handleFlowRoute(
            repoRoot,
            req.method ?? "GET",
            scenesUrl.pathname,
            req.method === "PUT" && scenesUrl.pathname === "/api/editor/flow" ? await readBody(req) : undefined,
          );
          if (flowReply) {
            sendJson(res, flowReply.status, flowReply.body);
            return;
          }
          // Gameplay grids and the content catalog (EA15, gameplay-routes.ts).
          const gameplayReply = await handleGameplayRoute(repoRoot, req.method ?? "GET", scenesUrl.pathname, req.headers["content-type"], () => readBody(req));
          if (gameplayReply) {
            sendJson(res, gameplayReply.status, gameplayReply.body);
            return;
          }
          const scenesReply = handleScenesRoute(
            repoRoot,
            req.method ?? "GET",
            scenesUrl.pathname,
            req.method === "PUT" ? await readBody(req) : undefined,
          );
          if (scenesReply) {
            sendJson(res, scenesReply.status, scenesReply.body);
            return;
          }
          const vcsReply = await handleVcsRoute(
            repoRoot,
            req.method ?? "GET",
            url,
            req.method === "POST" ? await readBody(req) : undefined,
          );
          if (vcsReply) {
            sendJson(res, vcsReply.status, vcsReply.body);
            return;
          }
          if (url.startsWith("/api/editor/database/")) {
            const u = new URL(url, "http://localhost");
            let body: unknown = {};
            if (req.method === "POST") {
              try {
                body = JSON.parse((await readBody(req)) || "{}") as unknown;
              } catch {
                sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
                return;
              }
            }
            dbCore ??= await openDatabaseCore(repoRoot, dataDir);
            const reply = await handleDatabase(
              { core: dbCore, serverRunning: async () => owned !== null || (await portOpen(serverPort)) },
              { method: req.method ?? "GET", route: u.pathname.slice("/api/editor/database/".length), contentType: req.headers["content-type"], body },
            );
            sendJson(res, reply.status, reply.body);
            return;
          }
          const rulesParsed = new URL(req.url ?? "/", "http://localhost");
          if (
            rulesParsed.pathname === "/api/editor/rules" ||
            rulesParsed.pathname.startsWith("/api/editor/rules/")
          ) {
            const parts = rulesParsed.pathname.split("/").filter(Boolean);
            if (req.method === "GET" && parts.length === 3) {
              sendJson(res, 200, { ok: true, files: ruleFileNames() });
              return;
            }
            let name = "";
            try {
              name = decodeURIComponent(parts[3] ?? "");
            } catch {
              sendJson(res, 400, { ok: false, error: "bad rules file name" });
              return;
            }
            if (parts.length !== 4 || !isRuleFile(name)) {
              sendJson(res, 404, { ok: false, error: `unknown rules file "${parts[3] ?? ""}"` });
              return;
            }
            if (req.method === "GET") {
              const { content, missing } = readRuleFile(repoRoot, name);
              sendJson(res, 200, { ok: true, name, content, missing });
              return;
            }
            if (req.method === "PUT") {
              let parsed: unknown;
              try {
                parsed = JSON.parse(await readBody(req)) as unknown;
              } catch {
                sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
                return;
              }
              if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) {
                sendJson(res, 400, { ok: false, error: 'need a JSON body shaped like {"content": …}' });
                return;
              }
              try {
                saveRuleFile(repoRoot, name, (parsed as { content: unknown }).content);
              } catch (err) {
                const status = (err as { status?: number }).status ?? 500;
                const issues = (err as { issues?: unknown }).issues;
                sendJson(res, status, {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                  ...(Array.isArray(issues) ? { issues } : {}),
                });
                return;
              }
              sendJson(res, 200, { ok: true, name });
              return;
            }
            sendJson(res, 404, { ok: false, error: "not found" });
            return;
          }
          // Quest and dialog documents (EA20, story-host.ts).
          const storyParsed = new URL(req.url ?? "/", "http://localhost");
          if (storyParsed.pathname === "/api/editor/story" || storyParsed.pathname.startsWith("/api/editor/story/")) {
            const sub = decodeURIComponent(storyParsed.pathname.slice("/api/editor/story".length + 1));
            if (req.method === "GET" && sub === "") {
              sendJson(res, 200, { ok: true, files: storyFileNames() });
              return;
            }
            if (req.method === "GET" && isStoryFile(sub)) {
              sendJson(res, 200, { ok: true, ...readStoryFile(repoRoot, sub) });
              return;
            }
            if (req.method === "POST" || req.method === "PUT") {
              let body: { content?: unknown; files?: unknown };
              try {
                body = JSON.parse(await readBody(req)) as typeof body;
              } catch {
                sendJson(res, 400, { ok: false, error: "request body is not valid JSON" });
                return;
              }
              if (req.method === "POST" && sub === "check") {
                sendJson(res, 200, { ok: true, issues: await checkStory(repoRoot, body.files as Parameters<typeof checkStory>[1]) });
                return;
              }
              if (req.method === "PUT" && (sub === "" || isStoryFile(sub))) {
                try {
                  const changes = sub === "" ? (body.files as Parameters<typeof saveStoryFiles>[1]) : { [sub]: body.content };
                  sendJson(res, 200, { ok: true, issues: await saveStoryFiles(repoRoot, changes) });
                } catch (err) {
                  const issues = (err as { issues?: unknown }).issues;
                  sendJson(res, (err as { status?: number }).status ?? 500, {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    ...(Array.isArray(issues) ? { issues } : {}),
                  });
                }
                return;
              }
            }
            sendJson(res, 404, { ok: false, error: "not found" });
            return;
          }
        } catch (err) {
          const status = (err as { status?: number }).status ?? 500;
          sendJson(res, status, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        next();
      });
    },
  };
}

/** Re-exported so existing imports keep working; the implementation lives in ./server-control.js (browser-safe). */
export { createHostServerControl } from "./server-control.js";
export type { HostServerControl, PlayServerLike } from "./server-control.js";
