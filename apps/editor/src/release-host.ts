/**
 * Loopback routes of the Release workspace (EA19), registered from host.ts.
 *
 *   GET  /api/editor/release/profiles              every profile with its problems and last cached steps
 *   GET|PUT|DELETE /api/editor/release/profiles/:name   one document (a refused save writes nothing)
 *   POST /api/editor/release/run {profile, force?} start the pipeline (one at a time)
 *   POST /api/editor/release/cancel
 *   GET  /api/editor/release/runs[/:id]            history; one run with its logs
 *   GET  /api/editor/release/packages              built packages and their manifests
 *   GET  /api/editor/release/target                the local target: live release, history, health
 *   POST /api/editor/release/deploy {package}      start a package locally and health-check it
 *   POST /api/editor/release/rollback {to?}        go back to an earlier release
 *   POST /api/editor/release/target/stop
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestDiff, validateProfile, type BuildProfile, type RunRecord } from "./release-model.js";
import { listPackages, listRuns, prunePackages, readCache, runPipeline, stepHashes, type Command } from "./release-pipeline.js";
import { checkHealth, deploy, readManifest, readState, releasesInUse, rollback, stopTarget, targetHealth, type TargetDeps } from "./release-targets.js";

interface Reply {
  status: number;
  body: unknown;
}
export interface ReleaseHostOptions {
  repoRoot: string;
  npmInvocation(args: string[]): { command: string; args: string[]; shell: boolean };
  killProcessTree(pid: number, signal: NodeJS.Signals): void;
}

export const profilesDir = (repoRoot: string): string => join(repoRoot, "content", "build");
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function listProfiles(repoRoot: string): Array<{ name: string; profile: unknown; issues: string[] }> {
  const dir = profilesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -5);
      try {
        const profile = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
        return { name, profile, issues: validateProfile(profile, name) };
      } catch (e) {
        return { name, profile: null, issues: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
      }
    });
}

export function saveProfile(repoRoot: string, name: string, doc: unknown): void {
  if (!NAME.test(name)) throw Object.assign(new Error(`bad profile name: ${name}`), { status: 400 });
  const issues = validateProfile(doc, name);
  if (issues.length) throw Object.assign(new Error(`invalid profile: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
  mkdirSync(profilesDir(repoRoot), { recursive: true });
  const file = join(profilesDir(repoRoot), `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function createReleaseHost(o: ReleaseHostOptions): { handle(method: string, pathname: string, body: () => Promise<string>): Promise<Reply | null>; dispose(): void } {
  const { repoRoot } = o;
  let active: { abort: AbortController; done: Promise<unknown>; id: number } | null = null;
  let live: RunRecord | null = null;
  let busy = false; // a deploy / rollback is in progress

  const git = (): { commit: string; dirty: boolean } => {
    const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
    const st = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    return { commit: rev.status === 0 ? rev.stdout.trim() : "unknown", dirty: st.status === 0 && st.stdout.trim() !== "" };
  };
  const exec = (cmd: Command, onLine: (l: string) => void, signal: AbortSignal): Promise<number> =>
    new Promise((resolve) => {
      const inv = cmd.kind === "npm" ? o.npmInvocation(cmd.args) : { command: process.execPath, args: cmd.args, shell: false };
      const child = spawn(inv.command, inv.args, {
        cwd: repoRoot,
        env: { ...process.env, ...cmd.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: inv.shell,
        detached: true,
        windowsHide: true,
      });
      let rest = "";
      const feed = (d: Buffer): void => {
        const lines = (rest + d.toString("utf8")).split(/\r?\n/);
        rest = lines.pop() ?? "";
        lines.forEach(onLine);
      };
      child.stdout?.on("data", feed);
      child.stderr?.on("data", feed);
      const stop = (): void => o.killProcessTree(child.pid ?? -1, "SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (e) => {
        onLine(String(e));
        resolve(1);
      });
      child.on("exit", (code) => {
        if (rest) onLine(rest);
        signal.removeEventListener("abort", stop);
        resolve(code ?? 1);
      });
    });
  const pipelineDeps = { repoRoot, exec, git, hasValgrind: () => spawnSync("valgrind", ["--version"], { stdio: "ignore" }).status === 0, now: Date.now };

  const targetDeps: TargetDeps = {
    repoRoot,
    start(pkgDir, dataDir, logFile) {
      const fd = openSync(logFile, "a");
      const child = spawn(process.execPath, [join(pkgDir, "start.mjs")], {
        cwd: pkgDir,
        env: { ...process.env, MMO_DATA_DIR: dataDir },
        stdio: ["ignore", fd, fd],
        detached: true,
        windowsHide: true,
      });
      child.unref();
      closeSync(fd);
      return child.pid ?? -1;
    },
    async stop(pid) {
      o.killProcessTree(pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 800));
      o.killProcessTree(pid, "SIGKILL");
    },
    health: checkHealth,
    now: Date.now,
  };

  const readProfile = (name: string): BuildProfile => {
    const found = listProfiles(repoRoot).find((p) => p.name === name);
    if (!found) throw Object.assign(new Error(`no profile ${name}`), { status: 404 });
    if (found.issues.length) throw Object.assign(new Error(`profile ${name} is invalid: ${found.issues.join("; ")}`), { status: 422 });
    return found.profile as BuildProfile;
  };

  async function handle(method: string, pathname: string, body: () => Promise<string>): Promise<Reply | null> {
    if (!pathname.startsWith("/api/editor/release/")) return null;
    const sub = pathname.slice("/api/editor/release/".length).split("/").map(decodeURIComponent);
    const json = async (): Promise<Record<string, unknown>> => {
      try {
        const v = JSON.parse((await body()) || "{}") as unknown;
        return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
      } catch {
        throw Object.assign(new Error("request body is not valid JSON"), { status: 400 });
      }
    };
    const ok = (b: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...b } });
    try {
      if (sub[0] === "profiles" && method === "GET" && sub.length === 1) {
        const cache = readCache(repoRoot);
        return ok({
          profiles: listProfiles(repoRoot).map((p) => ({
            ...p,
            cached: Object.keys(cache[p.name] ?? {}),
          })),
        });
      }
      if (sub[0] === "profiles" && sub.length === 2) {
        if (method === "GET") {
          const p = listProfiles(repoRoot).find((x) => x.name === sub[1]);
          return p ? ok({ ...p }) : { status: 404, body: { ok: false, error: "not found" } };
        }
        if (method === "PUT") {
          saveProfile(repoRoot, sub[1], (await json()).content);
          return ok();
        }
        if (method === "DELETE") {
          if (!NAME.test(sub[1])) return { status: 400, body: { ok: false, error: "bad profile name" } };
          rmSync(join(profilesDir(repoRoot), `${sub[1]}.json`), { force: true });
          return ok();
        }
      }
      if (sub[0] === "hashes" && method === "GET" && sub[1]) {
        return ok({ hashes: stepHashes(repoRoot, readProfile(sub[1])) });
      }
      if (sub[0] === "run" && method === "POST") {
        if (active) return { status: 409, body: { ok: false, error: `run ${active.id} is still going` } };
        const b = await json();
        const profile = readProfile(String(b.profile));
        const abort = new AbortController();
        const slot = { abort, id: 0, done: Promise.resolve() as Promise<unknown> };
        active = slot;
        live = null;
        let first!: (id: number) => void;
        const started = new Promise<number>((r) => (first = r));
        slot.done = runPipeline(pipelineDeps, profile, {
          force: b.force === true,
          signal: abort.signal,
          onUpdate: (r) => {
            live = r;
            slot.id = r.id;
            first(r.id);
          },
        })
          .then((r) => {
            live = r;
            if (r.status === "passed") prunePackages(repoRoot, 5, releasesInUse(repoRoot));
          })
          .catch((e: unknown) => {
            live = null;
            first(0);
            console.error("[release] pipeline crashed:", e);
          })
          .finally(() => {
            active = null;
          });
        return ok({ id: await started });
      }
      if (sub[0] === "cancel" && method === "POST") {
        active?.abort.abort();
        return ok({ cancelled: active !== null });
      }
      if (sub[0] === "runs" && method === "GET") {
        if (sub[1] === undefined) return ok({ runs: listRuns(repoRoot).map((r) => ({ ...r, steps: r.steps.map((s) => ({ ...s, log: [] })) })), active: active?.id ?? null });
        const id = Number(sub[1]);
        const run = live && live.id === id ? live : listRuns(repoRoot).find((r) => r.id === id);
        return run ? ok({ run, active: active?.id === id }) : { status: 404, body: { ok: false, error: "no such run" } };
      }
      if (sub[0] === "packages" && method === "GET") return ok({ packages: listPackages(repoRoot) });
      if (sub[0] === "target" && sub.length === 1 && method === "GET") {
        const state = readState(repoRoot);
        const { health } = await targetHealth(targetDeps).catch(() => ({ health: null }));
        const current = state.current ? readManifest(repoRoot, state.current) : null;
        return ok({ state, health, current });
      }
      if (sub[0] === "target" && sub[1] === "stop" && method === "POST") return ok({ stopped: await stopTarget(targetDeps) });
      if (sub[0] === "diff" && method === "GET" && sub[1]) {
        const state = readState(repoRoot);
        const prev = state.current ? readManifest(repoRoot, state.current) : null;
        return ok({ changes: manifestDiff(prev, readManifest(repoRoot, sub[1])) });
      }
      if ((sub[0] === "deploy" || sub[0] === "rollback") && method === "POST") {
        if (busy) return { status: 409, body: { ok: false, error: "a deploy is already in progress" } };
        busy = true;
        try {
          const b = await json();
          const r = sub[0] === "deploy" ? await deploy(targetDeps, String(b.package)) : await rollback(targetDeps, typeof b.to === "string" ? b.to : undefined);
          return { status: r.ok ? 200 : 502, body: { ...r, ok: r.ok } };
        } finally {
          busy = false;
        }
      }
      return { status: 404, body: { ok: false, error: "not found" } };
    } catch (err) {
      const e = err as { status?: number; issues?: unknown };
      return { status: e.status ?? 500, body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) } };
    }
  }

  return { handle, dispose: () => active?.abort.abort() };
}
