/**
 * The Release pipeline (EA19, host side): codegen, build, bakes, tests,
 * valgrind and package, each a step with a log, a time and a result.
 *
 * A step is cached by the hash of everything it reads. When its hash equals
 * the one stored from its last success (and its outputs still exist) the
 * step is skipped and reports "cached". It runs the same scripts the
 * terminal does; the commands are spelled out in `commandsFor`.
 *
 * State lives in `<repo>/.release/` (git-ignored): cache.json, runs/<id>.json,
 * work/<profile>/data (the bakes' output), packages/<name>/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stepLabel, stepsFor, type BuildProfile, type PackageManifest, type RunRecord, type StepId, type StepRecord } from "./release-model.js";
import { assemblePackage, hashParts, hashTree, workspaceDirs } from "./release-package.js";

/** A command a step runs: `npm` runs the same npm the editor runs under, `node` runs a script. */
export interface Command {
  kind: "npm" | "node";
  args: string[];
  env?: Record<string, string>;
  label: string;
}

export interface PipelineDeps {
  repoRoot: string;
  /** Run a command to its end, handing over each output line; resolves with the exit code. */
  exec(cmd: Command, onLine: (line: string) => void, signal: AbortSignal): Promise<number>;
  git(): { commit: string; dirty: boolean };
  hasValgrind(): boolean;
  now(): number;
}

export const releaseDir = (repoRoot: string): string => join(repoRoot, ".release");
const cacheFile = (repoRoot: string): string => join(releaseDir(repoRoot), "cache.json");
export const packagesDir = (repoRoot: string): string => join(releaseDir(repoRoot), "packages");
export const workDataDir = (repoRoot: string, profile: string): string => join(releaseDir(repoRoot), "work", profile, "data");

type Cache = Record<string, Record<string, { hash: string; at: number; durationMs: number; summary: string }>>;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  renameSync(tmp, file);
}

/** The commands each step runs. */
export function commandsFor(id: StepId, p: BuildProfile, dataDir: string): Command[] {
  const bakeEnv = { ...p.env, MMO_DATA_DIR: dataDir };
  switch (id) {
    case "codegen":
      return [{ kind: "node", args: ["scripts/codegen.mjs"], label: "node scripts/codegen.mjs" }];
    case "build":
      return p.build.map((ws) => ({ kind: "npm", args: ["run", "build", `--workspace=${ws}`], label: `npm run build --workspace=${ws}` }));
    case "bake:world":
      return [{ kind: "node", args: ["packages/engine-core/dist/src/bake-world.js"], env: bakeEnv, label: "bake-world" }];
    case "bake:dungeon":
      return [{ kind: "node", args: ["packages/dungeon/dist/src/cli.js", "--n", "10"], env: bakeEnv, label: "dungeon bake --n 10" }];
    case "bake:loot":
      return [{ kind: "node", args: ["packages/compose/dist/src/cli.js"], env: bakeEnv, label: "loot bake" }];
    case "test":
      return p.tests.map((ws) => ({ kind: "npm", args: ["test", `--workspace=${ws}`], label: `npm test --workspace=${ws}` }));
    case "valgrind":
      return [
        ...p.valgrind.memcheck.map((a): Command => ({ kind: "npm", args: ["run", "valgrind:memcheck", "--", a], label: `valgrind:memcheck ${a}` })),
        ...(p.valgrind.perf ? [{ kind: "npm", args: ["run", "valgrind:perf"], label: "valgrind:perf" } as Command] : []),
      ];
    case "package":
      return [];
  }
}

/** The files a step leaves behind; a cached step whose outputs are gone runs again. */
function outputsExist(id: StepId, p: BuildProfile, repoRoot: string, dirs: Record<string, string>, hashes: Record<StepId, string>): boolean {
  const data = workDataDir(repoRoot, p.name);
  switch (id) {
    case "codegen":
      return existsSync(join(repoRoot, "packages", "schema", "generated", "ts"));
    case "build":
      return p.build.every((ws) => existsSync(join(repoRoot, dirs[ws] ?? "", "dist")) || existsSync(join(repoRoot, dirs[ws] ?? "", "dist-app")));
    case "bake:world":
      return existsSync(join(data, "world.db"));
    case "bake:dungeon":
      return existsSync(join(data, "dungeons")) && readdirSync(join(data, "dungeons")).some((f) => f.endsWith(".dungeon.json"));
    case "bake:loot":
      return existsSync(join(data, "loot", "pool.jsonl"));
    case "package":
      return existsSync(join(packagesDir(repoRoot), packageName(p, hashes), "manifest.json"));
    default:
      return true;
  }
}

/** A package folder is named by its profile and the first bytes of its input hash. */
const packageName = (p: BuildProfile, hashes: Record<StepId, string>): string => `${p.name}-${hashes.package.slice(0, 8)}`;

/** Input hashes for every step of a profile. Tests and valgrind read more than the build does. */
export function stepHashes(repoRoot: string, p: BuildProfile): Record<StepId, string> {
  const code = hashTree(repoRoot, ["packages", "apps", "package.json", "package-lock.json", "scripts/codegen.mjs"], { tests: false });
  const withTests = hashTree(repoRoot, ["packages", "apps", "package.json", "package-lock.json"], { tests: true });
  const content = hashTree(repoRoot, ["content", "modules"], { tests: false });
  // Bakes read the engine's packages, not the apps: editing the editor does not rebake the world.
  const engine = hashTree(repoRoot, ["packages", "package-lock.json"], { tests: false });
  const bakeParts = (id: string) => ({ id, engine, content, env: p.env });
  const h: Record<string, string> = {
    codegen: hashTree(repoRoot, ["packages/schema/mmo_engine.fbs", "scripts/codegen.mjs"], { tests: false }),
    build: hashParts({ code, build: p.build }),
    "bake:world": hashParts(bakeParts("world")),
    "bake:dungeon": hashParts(bakeParts("dungeon")),
    "bake:loot": hashParts(bakeParts("loot")),
    test: hashParts({ withTests, content, tests: p.tests }),
    valgrind: hashParts({ code, valgrind: p.valgrind }),
  };
  h.package = hashParts({ code, content, profile: { ...p, description: "" }, bakes: [h["bake:world"], h["bake:dungeon"], h["bake:loot"]].filter((_, i) => p.bakes.includes((["world", "dungeon", "loot"] as const)[i])) });
  return h as Record<StepId, string>;
}

export function readCache(repoRoot: string): Cache {
  return readJson<Cache>(cacheFile(repoRoot), {});
}

export function listRuns(repoRoot: string): RunRecord[] {
  const dir = join(releaseDir(repoRoot), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<RunRecord | null>(join(dir, f), null))
    .filter((r): r is RunRecord => r !== null)
    .sort((a, b) => b.id - a.id);
}

const nextRunId = (repoRoot: string): number => (listRuns(repoRoot)[0]?.id ?? 0) + 1;
const saveRun = (repoRoot: string, run: RunRecord): void => writeJson(join(releaseDir(repoRoot), "runs", `${run.id}.json`), run);

export interface RunOptions {
  /** Ignore the cache: every step runs. */
  force?: boolean;
  signal?: AbortSignal;
  /** Called whenever the run changes (a step starts, a line arrives, a step ends). */
  onUpdate?: (run: RunRecord) => void;
}

const MAX_LOG = 4000;

/** A step that could not run on this machine and says so without failing the run. */
class Skipped extends Error {}

/** Run a profile's pipeline to its end (or its first failure); every step is recorded. */
export async function runPipeline(deps: PipelineDeps, profile: BuildProfile, opts: RunOptions = {}): Promise<RunRecord> {
  const { repoRoot } = deps;
  const dirs = workspaceDirs(repoRoot);
  const hashes = stepHashes(repoRoot, profile);
  const git = deps.git();
  const ids = stepsFor(profile);
  const run: RunRecord = {
    id: nextRunId(repoRoot),
    profile: profile.name,
    commit: git.commit,
    dirty: git.dirty,
    startedAt: deps.now(),
    status: "running",
    steps: ids.map((id): StepRecord => ({ id, label: stepLabel(id), status: "pending", hash: hashes[id].slice(0, 12), summary: "", log: [] })),
  };
  const signal = opts.signal ?? new AbortController().signal;
  const tick = (): void => {
    saveRun(repoRoot, run);
    opts.onUpdate?.(run);
  };
  tick();

  let failed = false;
  for (const step of run.steps) {
    if (failed || signal.aborted) {
      step.status = "skipped";
      step.summary = signal.aborted ? "cancelled" : "an earlier step failed";
      continue;
    }
    const cache = readCache(repoRoot);
    const hit = cache[profile.name]?.[step.id];
    if (!opts.force && hit?.hash === hashes[step.id] && outputsExist(step.id, profile, repoRoot, dirs, hashes)) {
      step.status = "cached";
      step.summary = `inputs unchanged (${step.hash}); last ran ${new Date(hit.at).toLocaleString()}: ${hit.summary}`;
      step.durationMs = 0;
      tick();
      continue;
    }
    step.status = "running";
    step.startedAt = deps.now();
    tick();
    const log = (line: string): void => {
      if (step.log.length < MAX_LOG) step.log.push({ at: deps.now(), line });
      opts.onUpdate?.(run);
    };
    try {
      step.summary = await runStep(deps, profile, step.id, hashes, git, log, signal, run);
      step.status = "passed";
      const next = readCache(repoRoot);
      (next[profile.name] ??= {})[step.id] = { hash: hashes[step.id], at: deps.now(), durationMs: deps.now() - step.startedAt, summary: step.summary };
      writeJson(cacheFile(repoRoot), next);
    } catch (e) {
      if (e instanceof Skipped) {
        step.status = "skipped";
        step.summary = e.message;
        step.durationMs = deps.now() - (step.startedAt ?? deps.now());
        tick();
        continue;
      }
      step.status = step.status === "running" && signal.aborted ? "skipped" : "failed";
      step.summary = signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e);
      log(step.summary);
      failed = !signal.aborted;
    }
    step.durationMs = deps.now() - step.startedAt;
    tick();
  }
  run.finishedAt = deps.now();
  run.status = signal.aborted ? "cancelled" : failed ? "failed" : "passed";
  tick();
  return run;
}

async function runCommands(deps: PipelineDeps, cmds: Command[], log: (l: string) => void, signal: AbortSignal): Promise<void> {
  for (const c of cmds) {
    log(`$ ${c.label}`);
    const code = await deps.exec(c, log, signal);
    if (signal.aborted) throw new Error("cancelled");
    if (code !== 0) throw new Error(`${c.label} exited with code ${code}`);
  }
}

async function runStep(
  deps: PipelineDeps,
  p: BuildProfile,
  id: StepId,
  hashes: Record<StepId, string>,
  git: { commit: string; dirty: boolean },
  log: (l: string) => void,
  signal: AbortSignal,
  run: RunRecord,
): Promise<string> {
  const { repoRoot } = deps;
  const data = workDataDir(repoRoot, p.name);
  if (id === "valgrind" && !deps.hasValgrind()) {
    if (p.valgrind.required) throw new Error("valgrind is required by this profile and is not installed on this machine");
    // Skipped, never cached: install valgrind and the step runs.
    log("valgrind is not installed on this machine; the step cannot run here");
    throw new Skipped("not run: valgrind is not installed on this machine");
  }
  if (id.startsWith("bake:")) {
    // The bake's folder is the pipeline's own output: clear what this bake wrote before, so it can write again
    // (bake-world refuses to overwrite a world, the dungeon pool would grow).
    mkdirSync(data, { recursive: true });
    const old = id === "bake:world" ? ["world.db", "world.db-wal", "world.db-shm"] : id === "bake:dungeon" ? ["dungeons"] : ["loot"];
    for (const f of old) rmSync(join(data, f), { recursive: true, force: true });
  }
  if (id === "package") {
    const name = packageName(p, hashes);
    log(`assembling ${name}`);
    const steps: Record<string, string> = {};
    for (const s of run.steps) if (s.id !== "package") steps[s.id] = hashes[s.id].slice(0, 12);
    const m: PackageManifest = assemblePackage({
      repoRoot,
      outDir: join(packagesDir(repoRoot), name),
      profile: p,
      dataDir: data,
      info: { name, commit: git.commit, dirty: git.dirty, builtAt: deps.now(), steps },
    });
    run.package = name;
    log(`${m.files} files, ${(m.bytes / 1e6).toFixed(1)} MB; ${m.workspaces.length} workspaces, ${m.thirdParty.length} third-party packages linked`);
    return `${name}: ${m.files} files, ${(m.bytes / 1e6).toFixed(1)} MB`;
  }
  const cmds = commandsFor(id, p, data);
  await runCommands(deps, cmds, log, signal);
  return cmds.map((c) => c.label).join("; ");
}

/** Keep the newest `keep` packages per profile plus any a target still lists; returns the ones removed. */
export function prunePackages(repoRoot: string, keep: number, inUse: Set<string>): string[] {
  const dir = packagesDir(repoRoot);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir)
    .map((name) => ({ name, m: readJson<PackageManifest | null>(join(dir, name, "manifest.json"), null) }))
    .filter((x): x is { name: string; m: PackageManifest } => x.m !== null)
    .sort((a, b) => b.m.builtAt - a.m.builtAt);
  const seen = new Map<string, number>();
  const removed: string[] = [];
  for (const { name, m } of all) {
    const n = (seen.get(m.profile) ?? 0) + 1;
    seen.set(m.profile, n);
    if (n > keep && !inUse.has(name)) {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

export function listPackages(repoRoot: string): PackageManifest[] {
  const dir = packagesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => readJson<PackageManifest | null>(join(dir, name, "manifest.json"), null))
    .filter((m): m is PackageManifest => m !== null)
    .sort((a, b) => b.builtAt - a.builtAt);
}
