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
 *   GET  /api/editor/assets        → art-pack scan of <repo>/assets
 *   GET  /assets/*                 → static files from <repo>/assets
 *                                    (path-traversal guarded)
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
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

export function editorHost(options: EditorHostOptions): Plugin {
  const repoRoot = resolve(options.repoRoot);
  const serverPort = options.serverPort ?? 7777;
  // `npm run server` rebuilds five packages before listening (~27 s measured
  // on Windows), so 30 s left almost no margin.
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const assetsRoot = join(repoRoot, "assets");
  const dataDir = resolve(options.dataDir ?? join(repoRoot, "packages", "engine-core", "data"));
  let owned: OwnedServer | null = null;

  /**
   * Run the engine's terrain tool (export | generate | import) as its own
   * process — native SQLite/procgen code never loads into Vite — with the
   * editor's world as MMO_DATA_DIR. Resolves with its JSON output; a
   * failure rejects with the tool's message.
   */
  function runTerrainTool(cmd: "export" | "generate" | "import", input?: string): Promise<unknown> {
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
      }, 60_000);
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

  async function startOwned(): Promise<OwnedServer> {
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
    const usersCsv = join(dataDir, "users.csv");
    const { username, password } = editorLogin(dataDir);
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

    const npm = npmInvocation([
      "run",
      "server",
      "--workspace=@mmo-engine/engine-core",
      "--silent",
    ]);
    const child = spawn(npm.command, npm.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        MMO_PORT: String(serverPort),
        MMO_DATA_DIR: dataDir,
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
    const onData = (d: Buffer): void => {
      output += d.toString("utf8");
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
            await readBody(req);
            const s = await startOwned();
            sendJson(res, 200, {
              ok: true,
              pid: s.pid,
              port: s.port,
              url: s.url,
              username: s.username,
              // Dev-only, one-session credential over localhost (see
              // startOwned). Never logged; only the hash is persisted.
              password: s.password,
            });
            return;
          }
          if (url === "/api/editor/server/stop" && req.method === "POST") {
            await readBody(req);
            const stopped = await stopOwned();
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
          if (url === "/api/editor/assets" && req.method === "GET") {
            sendJson(res, 200, { ok: true, ...(await assetScan()) });
            return;
          }
          if (url.startsWith("/assets/") && req.method === "GET") {
            serveAssetFile(req, res);
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
