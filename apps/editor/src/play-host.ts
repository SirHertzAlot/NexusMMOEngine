/**
 * Host side of the Play menu (EA14), beside the owned server in host.ts.
 *
 *   GET/PUT /api/editor/play/setups   the saved setups, content/play/setups.json
 *                                     (a refused save lists every problem, writes nothing)
 *
 * and the helpers a play start uses: seeding the session's scratch accounts,
 * starting the player's client dev server for "new window" play, and
 * waiting for the edge's health.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptySetups, validatePlaySetups } from "./play-setups.js";
import type { PlaySceneRequest } from "./scene-play.js";

export const setupsFile = (repoRoot: string): string => join(resolve(repoRoot, "content", "play"), "setups.json");

export function saveSetups(repoRoot: string, content: unknown): void {
  const issues = validatePlaySetups(content);
  if (issues.length > 0) {
    throw Object.assign(new Error(`invalid play setups: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
  }
  const file = setupsFile(repoRoot);
  mkdirSync(resolve(repoRoot, "content", "play"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function handlePlayRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
): { status: number; body: unknown } | null {
  if (pathname !== "/api/editor/play/setups") return null;
  try {
    if (method === "GET") {
      const file = setupsFile(repoRoot);
      return { status: 200, body: { ok: true, content: existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : emptySetups() } };
    }
    if (method === "PUT") {
      let parsed: { content?: unknown };
      try {
        parsed = JSON.parse(body ?? "") as { content?: unknown };
      } catch {
        return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
      }
      if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) {
        return { status: 400, body: { ok: false, error: 'need a JSON body shaped like {"content": …}' } };
      }
      saveSetups(repoRoot, parsed.content);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    const e = err as { status?: number; issues?: unknown };
    return {
      status: e.status ?? 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
    };
  }
}

/**
 * Create the session's accounts in a scratch CSV with the engine's own
 * seed-user (argon2id hashes; the password only passes through the child's
 * environment). The real users.csv is never named here.
 */
export function seedAccounts(repoRoot: string, usersCsv: string, names: string[], password: string): Promise<void> {
  return new Promise((resolveSeed, rejectSeed) => {
    const seed = spawn(process.execPath, ["packages/engine-core/dist/src/auth/seed-user.js", "--csv", usersCsv, ...names], {
      cwd: repoRoot,
      env: { ...process.env, MMO_DEV_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    seed.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = setTimeout(() => {
      seed.kill("SIGKILL");
      rejectSeed(new Error("seed-user timed out"));
    }, 60_000);
    timer.unref?.();
    seed.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveSeed();
      else rejectSeed(new Error(`seed-user exited ${code}: ${err.slice(-500)}`));
    });
    seed.on("error", (e) => {
      clearTimeout(timer);
      rejectSeed(e);
    });
  });
}

/** Poll a URL until it answers 2xx (JSON bodies are returned parsed). */
export async function waitForHttp(url: string, ok: (body: unknown) => boolean, timeoutMs: number): Promise<unknown> {
  const end = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        /* not JSON */
      }
      if (res.ok && ok(body)) return body;
      last = `HTTP ${res.status} ${text.slice(0, 100)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not become healthy: ${last}`);
}

/**
 * The player's client dev server, for "new window" play: used if one is
 * already answering on the port, otherwise started here and stopped with
 * the editor.
 */
export function createClientServer(repoRoot: string, port = 5173): { ensure(): Promise<string>; stop(): void } {
  let child: ChildProcess | null = null;
  const url = `http://127.0.0.1:${port}/`;
  return {
    async ensure() {
      const up = await fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
      if (up) return url;
      if (!child || child.exitCode !== null) {
        const vite = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
        if (!existsSync(vite)) throw new Error("vite is not installed: run npm install");
        child = spawn(process.execPath, [vite, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
          cwd: join(repoRoot, "apps", "client"),
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      }
      await waitForHttp(url, () => true, 60_000);
      return url;
    },
    stop() {
      child?.kill();
      child = null;
    },
  };
}

/** The Play menu's start options (EA14); everything is optional. */
export interface PlayStartRequest {
  bots?: number;
  scene?: PlaySceneRequest;
  /** 1 to 8 seeded accounts. */
  clients?: number;
  /** "edge" also starts the edge process beside the core. */
  network?: "core" | "edge";
  /** Round-trip delay for the client connections, ms. */
  latencyMs?: number;
  /** A fresh world instead of continuing the saved one. */
  fresh?: boolean;
  /** Write the session's world back to the saved one on stop. */
  keep?: boolean;
}

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : undefined;

/** Read a start body; fields that are missing or out of range are left to the server's defaults. */
export function parsePlayStart(body: string): PlayStartRequest {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(body || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
  if (typeof p !== "object" || p === null) return {};
  const out: PlayStartRequest = {};
  const bots = int(p.bots, 0, 1000);
  if (bots !== undefined) out.bots = bots;
  const clients = int(p.clients, 1, 8);
  if (clients !== undefined) out.clients = clients;
  const latencyMs = int(p.latencyMs, 0, 2000);
  if (latencyMs !== undefined) out.latencyMs = latencyMs;
  if (p.network === "core" || p.network === "edge") out.network = p.network;
  if (typeof p.fresh === "boolean") out.fresh = p.fresh;
  if (typeof p.keep === "boolean") out.keep = p.keep;
  if (typeof p.scene === "object" && p.scene !== null) out.scene = p.scene as PlaySceneRequest;
  return out;
}
