/**
 * The local deploy target (EA19, host side): start a package on this
 * machine, check its health, and roll back.
 *
 * `.release/targets/local/` holds state.json (which package is live, its pid,
 * the last releases), data/ (the target's own world and accounts, seeded once
 * from the package's baked data and kept across releases) and server.log.
 *
 * Deploy stops the live release, starts the new one and waits for its health:
 * the server's WebSocket port opens and, when the package has the edge, its
 * `GET /health` reports the core up. A release that fails its check is stopped
 * and the previous one is started again.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManifest } from "./release-model.js";
import { isAccountFile } from "./release-package.js";
import { packagesDir, releaseDir } from "./release-pipeline.js";

export interface ReleaseEntry {
  package: string;
  deployedAt: number;
  /** live: running now; replaced: a later release took over; failed: did not pass its health check. */
  outcome: "live" | "replaced" | "failed";
  /** Started by a rollback rather than a deploy. */
  rollback?: boolean;
}

export interface TargetState {
  current: string | null;
  pid: number | null;
  /** Newest first. */
  releases: ReleaseEntry[];
}

export interface Health {
  ok: boolean;
  server: { ok: boolean; detail: string; port: number };
  edge?: { ok: boolean; detail: string; port: number };
}

export interface TargetDeps {
  repoRoot: string;
  /** Start the package's start.mjs with this data folder; resolves with the pid of what it started. */
  start(pkgDir: string, dataDir: string, logFile: string): number;
  /** End that process and what it started. */
  stop(pid: number): Promise<void>;
  health(manifest: PackageManifest): Promise<Health>;
  now(): number;
  /** How long a new release has to become healthy. */
  healthTimeoutMs?: number;
}

export const targetDir = (repoRoot: string): string => join(releaseDir(repoRoot), "targets", "local");
const stateFile = (repoRoot: string): string => join(targetDir(repoRoot), "state.json");
export const KEEP_RELEASES = 5;

export function readState(repoRoot: string): TargetState {
  try {
    const s = JSON.parse(readFileSync(stateFile(repoRoot), "utf8")) as Partial<TargetState>;
    return { current: s.current ?? null, pid: s.pid ?? null, releases: Array.isArray(s.releases) ? s.releases : [] };
  } catch {
    return { current: null, pid: null, releases: [] };
  }
}

function writeState(repoRoot: string, s: TargetState): void {
  mkdirSync(targetDir(repoRoot), { recursive: true });
  const tmp = `${stateFile(repoRoot)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1), "utf8");
  renameSync(tmp, stateFile(repoRoot));
}

export function readManifest(repoRoot: string, name: string): PackageManifest {
  if (!/^[a-z0-9-]+$/.test(name)) throw Object.assign(new Error(`not a package name: ${name}`), { status: 400 });
  const file = join(packagesDir(repoRoot), name, "manifest.json");
  if (!existsSync(file)) throw Object.assign(new Error(`no package ${name}: run the pipeline first`), { status: 404 });
  return JSON.parse(readFileSync(file, "utf8")) as PackageManifest;
}

/** The packages a rollback can still go back to (and prune must keep). */
export const releasesInUse = (repoRoot: string): Set<string> => new Set(readState(repoRoot).releases.map((r) => r.package));

async function waitHealthy(deps: TargetDeps, m: PackageManifest): Promise<Health> {
  const end = deps.now() + (deps.healthTimeoutMs ?? 90_000);
  let h = await deps.health(m);
  while (!h.ok && deps.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    h = await deps.health(m);
  }
  return h;
}

export interface DeployResult {
  ok: boolean;
  /** The release that is live now (the new one, or the one it fell back to). */
  live: string | null;
  health?: Health;
  /** The new release failed its check and the previous one is running again. */
  rolledBack?: boolean;
  error?: string;
}

async function startRelease(deps: TargetDeps, name: string): Promise<{ pid: number; health: Health }> {
  const dir = targetDir(deps.repoRoot);
  const pkg = join(packagesDir(deps.repoRoot), name);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  // The target keeps its own world: baked data is copied in once and never over what is there.
  if (existsSync(join(pkg, "data"))) {
    cpSync(join(pkg, "data"), data, { recursive: true, force: false, errorOnExist: false, filter: (s) => !isAccountFile(s.split(/[\\/]/).pop() as string) });
  }
  const pid = deps.start(pkg, data, join(dir, "server.log"));
  const health = await waitHealthy(deps, readManifest(deps.repoRoot, name));
  return { pid, health };
}

/** Make `name` the live release. Never leaves the target without a running release when one was running. */
export async function deploy(deps: TargetDeps, name: string, opts: { rollback?: boolean } = {}): Promise<DeployResult> {
  const { repoRoot } = deps;
  readManifest(repoRoot, name);
  const state = readState(repoRoot);
  const previous = state.current;
  if (state.pid !== null) await deps.stop(state.pid);
  state.pid = null;
  state.current = null;
  const entry: ReleaseEntry = { package: name, deployedAt: deps.now(), outcome: "live", ...(opts.rollback ? { rollback: true } : {}) };
  let started: { pid: number; health: Health } | null = null;
  let error: string | undefined;
  try {
    started = await startRelease(deps, name);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (started?.health.ok) {
    for (const r of state.releases) if (r.outcome === "live") r.outcome = "replaced";
    state.current = name;
    state.pid = started.pid;
    state.releases = [entry, ...state.releases].slice(0, KEEP_RELEASES * 2);
    writeState(repoRoot, state);
    return { ok: true, live: name, health: started.health };
  }
  // The new release did not come up: end it, and put the previous one back.
  if (started) await deps.stop(started.pid);
  entry.outcome = "failed";
  for (const r of state.releases) if (r.outcome === "live") r.outcome = "replaced";
  state.releases = [entry, ...state.releases].slice(0, KEEP_RELEASES * 2);
  let rolledBack = false;
  if (previous) {
    try {
      const back = await startRelease(deps, previous);
      if (back.health.ok) {
        state.current = previous;
        state.pid = back.pid;
        rolledBack = true;
        const prev = state.releases.find((r) => r.package === previous && r.outcome === "replaced");
        if (prev) prev.outcome = "live";
      } else await deps.stop(back.pid);
    } catch {
      /* the previous release would not start either: the target is down */
    }
  }
  writeState(repoRoot, state);
  return {
    ok: false,
    live: state.current,
    health: started?.health,
    rolledBack,
    error: error ?? `${name} failed its health check${started ? `: ${healthLine(started.health)}` : ""}${rolledBack ? `; ${previous} is running again` : ""}`,
  };
}

export const healthLine = (h: Health): string => [h.server, h.edge].filter(Boolean).map((p) => `${p === h.server ? "server" : "edge"} ${p?.detail}`).join(", ");

/** Go back to an earlier release (the one before the live one when none is named). */
export async function rollback(deps: TargetDeps, to?: string): Promise<DeployResult> {
  const state = readState(deps.repoRoot);
  const target = to ?? state.releases.find((r) => r.outcome === "replaced" && r.package !== state.current && existsSync(join(packagesDir(deps.repoRoot), r.package, "manifest.json")))?.package;
  if (!target) throw Object.assign(new Error("there is no earlier release to go back to"), { status: 409 });
  return deploy(deps, target, { rollback: true });
}

/** Stop the live release; the target stays configured. */
export async function stopTarget(deps: TargetDeps): Promise<boolean> {
  const state = readState(deps.repoRoot);
  if (state.pid === null) return false;
  await deps.stop(state.pid);
  writeState(deps.repoRoot, { ...state, pid: null });
  return true;
}

/** The live release's health right now (server port and, with the edge, its /health). */
export async function targetHealth(deps: TargetDeps): Promise<{ current: string | null; health: Health | null }> {
  const state = readState(deps.repoRoot);
  if (!state.current || state.pid === null) return { current: state.current, health: null };
  return { current: state.current, health: await deps.health(readManifest(deps.repoRoot, state.current)) };
}

/** The real health check: the server's WebSocket opens, and the edge (if shipped) answers GET /health with the core up. */
export async function checkHealth(m: PackageManifest): Promise<Health> {
  const port = Number(m.env.MMO_PORT ?? 7777);
  const server = await new Promise<Health["server"]>((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve({ ok, detail, port });
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => finish(false, `port ${port} did not answer`), 2000);
    ws.addEventListener("open", () => finish(true, `port ${port} accepts connections`));
    ws.addEventListener("error", () => finish(false, `port ${port} is not open`));
  });
  if (!m.edge) return { ok: server.ok, server };
  const edgePort = Number(m.env.EDGE_HTTP_PORT ?? 3000);
  const edge: NonNullable<Health["edge"]> = await fetch(`http://127.0.0.1:${edgePort}/health`, { signal: AbortSignal.timeout(2000) }).then(
    async (r) => {
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; core?: string };
      return { ok: r.ok && b.core === "up", detail: `/health on ${edgePort}: HTTP ${r.status}, core ${b.core ?? "unknown"}`, port: edgePort };
    },
    () => ({ ok: false, detail: `/health on ${edgePort} did not answer`, port: edgePort }),
  );
  return { ok: server.ok && edge.ok, server, edge };
}
