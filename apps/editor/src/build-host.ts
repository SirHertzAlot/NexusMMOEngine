/**
 * Editor build host (EA19 pipeline view): profiles, background runs with
 * stage-by-stage status, bounded run history.
 *
 * The pipeline runner is injected so tests can fake it; host.ts wires in
 * the real `runProfile` from @mmo-engine/build. At most one run at a
 * time — a second start while running is a 409, not a queue.
 */
import type { BuildProfile, StageResult } from "@mmo-engine/build";
import {
  assemblePackage,
  collectInputFiles,
  defaultProfile,
  deployLocal,
  loadProfile,
  verifyManifest,
  type PackageManifest,
} from "@mmo-engine/build";
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { deleteProfileFile, saveProfileFile } from "./build-profiles.js";

export type StageStatus = "pending" | "running" | "skipped" | "passed" | "failed";
export type RunStatus = "running" | "passed" | "failed";

export interface StageState {
  id: string;
  status: StageStatus;
  ms: number;
}

export interface RunRecord {
  id: string;
  profile: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  stages: StageState[];
  error?: string;
}

/** runProfile-shaped: the host drives it in the background. */
export type PipelineRunner = (
  rootDir: string,
  profile: BuildProfile,
  onStage: (result: StageResult) => void,
  /** fresh: ignore the stage cache, every stage runs. */
  opts?: { fresh?: boolean },
) => Promise<void>;

export type DeployStatus = "idle" | "running" | "ok" | "failed";

export interface DeployState {
  status: DeployStatus;
  rolledBack: boolean;
  finishedAt: string | null;
  error?: string;
}

export interface DeployResult {
  ok: boolean;
  rolledBack: boolean;
}

/** Assemble + deploy the local target in the background. */
export type Deployer = (port: number) => Promise<DeployResult>;

export interface BuildHostOptions {
  rootDir: string;
  profiles: BuildProfile[];
  runner: PipelineRunner;
  deployer: Deployer;
  maxRuns?: number;
}

export interface BuildHost {
  listProfiles(): BuildProfile[];
  startRun(profileName: string, opts?: { fresh?: boolean }): RunRecord;
  /** Validate and write a profile file (content/build/profiles); replaces one of the same name. */
  saveProfile(raw: unknown): BuildProfile;
  /** Delete a profile file; false when there was none. */
  deleteProfile(name: string): boolean;
  getRun(id: string): RunRecord | null;
  listRuns(): RunRecord[];
  /** Resolve when the run finishes (for tests and the deploy flow). */
  waitFor(id: string): Promise<RunRecord>;
  startDeploy(port: number): DeployState;
  getDeploy(): DeployState;
}

let seq = 0;

/**
 * Profiles: the default pipeline plus any `content/build/profiles/*.json`.
 * An invalid profile file is skipped (logged), never fatal — a broken
 * profile shouldn't take down the editor host.
 */
export function loadProfiles(repoRoot: string, onWarn?: (msg: string) => void): BuildProfile[] {
  const profiles: BuildProfile[] = [defaultProfile()];
  const dir = join(repoRoot, "content", "build", "profiles");
  if (!existsSync(dir)) return profiles;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      profiles.push(loadProfile(JSON.parse(readFileSync(join(dir, f), "utf8"))));
    } catch (err) {
      onWarn?.(`build profiles: skipping ${f}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return profiles;
}

/**
 * The local deployer: assemble the package (built server + content +
 * manifest), verify it, and deploy with health-check + rollback.
 * The package inputs mirror scripts/package.mjs.
 */
export function createLocalDeployer(repoRoot: string): Deployer {
  return async (port: number): Promise<DeployResult> => {
    const pkgDir = join(repoRoot, "dist", "package");
    const files = collectInputFiles(repoRoot, [
      "packages/engine-core/dist",
      "packages/engine-core/package.json",
      "content",
    ]);
    assemblePackage(repoRoot, pkgDir, "default", files);
    const manifest = JSON.parse(readFileSync(join(pkgDir, "manifest.json"), "utf8")) as PackageManifest;
    const v = verifyManifest(pkgDir, manifest);
    if (!v.ok) throw new Error(`package manifest failed: ${v.problems.join("; ")}`);
    const nm = join(pkgDir, "node_modules");
    if (!existsSync(nm)) symlinkSync(join(repoRoot, "node_modules"), nm, "dir");
    const res = await deployLocal(pkgDir, {
      deployDir: join(repoRoot, "dist", "deploy", "local"),
      startCommand: `MMO_PORT=${port} node packages/engine-core/dist/src/server.js`,
      healthUrl: `http://127.0.0.1:${port}/health`,
    });
    // Leave the server running on success; the operator stops it.
    return { ok: res.ok, rolledBack: res.rolledBack };
  };
}

export function createBuildHost(opts: BuildHostOptions): BuildHost {
  const maxRuns = opts.maxRuns ?? 20;
  const runs: RunRecord[] = [];
  const waiters = new Map<string, Array<(r: RunRecord) => void>>();
  let deploy: DeployState = { status: "idle", rolledBack: false, finishedAt: null };

  function finish(rec: RunRecord): void {
    rec.finishedAt = new Date().toISOString();
    const ws = waiters.get(rec.id) ?? [];
    waiters.delete(rec.id);
    for (const w of ws) w(rec);
  }

  return {
    listProfiles(): BuildProfile[] {
      return opts.profiles;
    },

    saveProfile(raw: unknown): BuildProfile {
      const p = saveProfileFile(opts.rootDir, raw);
      const at = opts.profiles.findIndex((x) => x.name === p.name);
      if (at < 0) opts.profiles.push(p);
      else opts.profiles[at] = p;
      return p;
    },

    deleteProfile(name: string): boolean {
      const gone = deleteProfileFile(opts.rootDir, name);
      const at = opts.profiles.findIndex((x) => x.name === name);
      if (at >= 0) opts.profiles.splice(at, 1);
      return gone;
    },

    startRun(profileName: string, runOpts?: { fresh?: boolean }): RunRecord {
      const profile = opts.profiles.find((p) => p.name === profileName);
      if (!profile) throw new Error(`unknown profile: ${profileName}`);
      if (runs.some((r) => r.status === "running")) {
        throw new Error("a pipeline run is already running");
      }
      const rec: RunRecord = {
        id: `run-${Date.now()}-${seq++}`,
        profile: profileName,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: "running",
        stages: profile.stages.map((s): StageState => ({ id: s.id, status: "pending", ms: 0 })),
      };
      runs.unshift(rec);
      while (runs.length > maxRuns) runs.pop();

      // Drive the pipeline in the background; stage callbacks update the record.
      void (async () => {
        try {
          await opts.runner(
            opts.rootDir,
            profile,
            (result) => {
              const st = rec.stages.find((s) => s.id === result.id);
              if (!st) return;
              st.ms = result.ms;
              st.status = result.exitCode === null ? "skipped" : result.exitCode === 0 ? "passed" : "failed";
              if (st.status === "failed") {
                for (const later of rec.stages) {
                  if (later.status === "pending") later.status = "skipped";
                }
              }
            },
            runOpts?.fresh ? { fresh: true } : undefined,
          );
          rec.status = rec.stages.some((s) => s.status === "failed") ? "failed" : "passed";
        } catch (err) {
          rec.status = "failed";
          rec.error = err instanceof Error ? err.message : String(err);
        }
        finish(rec);
      })();
      return rec;
    },

    getRun(id: string): RunRecord | null {
      return runs.find((r) => r.id === id) ?? null;
    },

    listRuns(): RunRecord[] {
      return [...runs];
    },

    waitFor(id: string): Promise<RunRecord> {
      const rec = runs.find((r) => r.id === id);
      if (!rec) return Promise.reject(new Error(`unknown run: ${id}`));
      if (rec.status !== "running") return Promise.resolve(rec);
      return new Promise((resolve) => {
        const ws = waiters.get(id) ?? [];
        ws.push(resolve);
        waiters.set(id, ws);
      });
    },

    startDeploy(port: number): DeployState {
      if (deploy.status === "running") throw new Error("a deploy is already running");
      deploy = { status: "running", rolledBack: false, finishedAt: null };
      void (async () => {
        try {
          const res = await opts.deployer(port);
          deploy = {
            status: res.ok ? "ok" : "failed",
            rolledBack: res.rolledBack,
            finishedAt: new Date().toISOString(),
          };
        } catch (err) {
          deploy = {
            status: "failed",
            rolledBack: false,
            finishedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })();
      return deploy;
    },

    getDeploy(): DeployState {
      return deploy;
    },
  };
}
