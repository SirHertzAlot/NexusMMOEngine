/**
 * Host side of the Play menu (EA14): the saved setups document, the
 * player's client dev server for "new window" play, and the edge process
 * for "Edge + core". Pure helpers are exported so node:test can reach them.
 *
 *   GET/PUT /api/editor/play/setups   content/play/setups.json
 *                                     (a refused save lists every problem, writes nothing)
 *   POST    /api/editor/play/client   the player's client URL (started on demand)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { playSetupSchema } from "./ui/play-setup.js";
import { normalizeShortcut, validateShortcut } from "./ui/play-shortcuts.js";

export interface SetupsDoc {
  version: 1;
  setups: Array<{ name: string; shortcut?: string; setup: Record<string, unknown> }>;
}

export const emptySetups = (): SetupsDoc => ({ version: 1, setups: [] });
export const setupsFile = (repoRoot: string): string => join(resolve(repoRoot, "content", "play"), "setups.json");

/** Every problem with a setups document (empty = valid). */
export function validateSetupsDoc(doc: unknown): string[] {
  if (typeof doc !== "object" || doc === null) return ["document must be an object"];
  const d = doc as { version?: unknown; setups?: unknown };
  if (d.version !== 1) return ["version must be 1"];
  if (!Array.isArray(d.setups)) return ["setups must be a list"];
  const issues: string[] = [];
  const names = new Set<string>();
  const bound: Array<{ name: string; shortcut: string | null }> = [];
  d.setups.forEach((s: unknown, i) => {
    const at = `setups[${i}]`;
    const e = s as { name?: unknown; shortcut?: unknown; setup?: unknown } | null;
    if (typeof e !== "object" || e === null) return void issues.push(`${at}: must be an object`);
    if (typeof e.name !== "string" || e.name.trim() === "" || e.name.length > 40) issues.push(`${at}: name must be 1 to 40 characters`);
    else if (names.has(e.name)) issues.push(`${at}: duplicate name "${e.name}"`);
    else names.add(e.name);
    if (e.shortcut !== undefined) {
      const norm = typeof e.shortcut === "string" ? normalizeShortcut(e.shortcut) : null;
      const why = norm === null || norm !== e.shortcut ? `“${String(e.shortcut)}” is not a key` : validateShortcut(norm, bound);
      if (why) issues.push(`${at}: shortcut ${why}`);
      else bound.push({ name: String(e.name), shortcut: norm });
    }
    const r = playSetupSchema.safeParse(e.setup);
    if (!r.success) for (const p of r.error.issues) issues.push(`${at}.setup.${p.path.join(".")}: ${p.message}`);
  });
  return issues;
}

export function saveSetups(repoRoot: string, content: unknown): void {
  const issues = validateSetupsDoc(content);
  if (issues.length > 0) {
    throw Object.assign(new Error(`invalid play setups: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
  }
  const file = setupsFile(repoRoot);
  mkdirSync(resolve(repoRoot, "content", "play"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function handlePlaySetupsRoute(
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

/** Poll a URL until it answers 2xx and `ok(body)` holds. */
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

/** Start the edge beside the core (building it first if needed) and wait until GET /health reports the core up. */
export async function startEdge(
  repoRoot: string,
  dataDir: string,
  npmInvocation: (args: string[]) => { command: string; args: string[]; shell: boolean },
  killTree: (pid: number) => void,
): Promise<ChildProcess> {
  const edgeJs = join(repoRoot, "apps", "edge", "dist", "src", "index.js");
  if (!existsSync(edgeJs)) {
    const npm = npmInvocation(["run", "build", "--workspace=@mmo-engine/edge", "--silent"]);
    const r = spawnSync(npm.command, npm.args, { cwd: repoRoot, shell: npm.shell, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`building the edge failed:\n${(r.stdout + r.stderr).slice(-1500)}`);
  }
  const edge = spawn(process.execPath, [edgeJs], {
    cwd: repoRoot,
    env: { ...process.env, MMO_DATA_DIR: dataDir },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  edge.unref();
  try {
    await waitForHttp("http://127.0.0.1:3000/health", (b) => (b as { core?: string })?.core === "up", 30_000);
  } catch (e) {
    if (edge.pid) killTree(edge.pid);
    throw new Error(`the edge did not come up beside the core: ${e instanceof Error ? e.message : String(e)}`);
  }
  return edge;
}
