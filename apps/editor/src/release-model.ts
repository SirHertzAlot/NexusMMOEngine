/**
 * Build profiles and pipeline records (EA19). Pure and browser-safe: the
 * Release workspace and the host both validate profiles with it, so a
 * refused save writes nothing.
 *
 * A profile is the document `content/build/<name>.json`: which workspaces
 * the build covers, which bakes run, which tests, whether valgrind runs,
 * which modules ship, the server's environment, and the target.
 */

export const STEP_IDS = ["codegen", "build", "bake:world", "bake:dungeon", "bake:loot", "test", "valgrind", "package"] as const;
export type StepId = (typeof STEP_IDS)[number];
export const BAKES = ["world", "dungeon", "loot"] as const;
export const TARGETS = ["local"] as const;

export interface BuildProfile {
  version: 1;
  /** Same as the file name; lowercase-dashes. */
  name: string;
  description: string;
  /** Where `deploy` puts the package: only "local" exists (staging waits on the container-platform decision). */
  target: "local";
  /** Workspaces whose `npm run build` makes up the build step; each one builds its own dependencies first. */
  build: string[];
  /** Which bakes run, writing into the profile's work folder. */
  bakes: Array<(typeof BAKES)[number]>;
  /** Workspaces whose tests run; empty skips the step. */
  tests: string[];
  valgrind: {
    /** Native addons to run `valgrind:memcheck` on. */
    memcheck: string[];
    /** Run `valgrind:perf` against the baseline. */
    perf: boolean;
    /** A machine without valgrind fails the run instead of skipping the step. */
    required: boolean;
  };
  /** Modules the package ships enabled (written to its content/modules.json). */
  modules: string[];
  /** The edge process ships and is health-checked beside the core. */
  edge: boolean;
  /** The server's environment (MMO_*, plus the edge's ports). */
  env: Record<string, string>;
}

export const ENV_KEY = /^(MMO_[A-Z0-9_]{1,40}|EDGE_HTTP_PORT|EDGE_WS_PORT|CORE_CHANNEL_PORT)$/;
const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const WORKSPACE = /^@mmo-engine\/[a-z0-9-]{1,40}$/;
/** Environment values that must be ports. */
const isPortKey = (k: string): boolean => /(^|_)PORT$/.test(k);

export function emptyProfile(name: string): BuildProfile {
  return {
    version: 1,
    name,
    description: "",
    target: "local",
    build: ["@mmo-engine/engine-core"],
    bakes: ["world"],
    tests: [],
    valgrind: { memcheck: [], perf: false, required: false },
    modules: ["core"],
    edge: false,
    env: { MMO_PORT: "7790", MMO_ALLOW_REGISTER: "0" },
  };
}

/** Every problem with a profile (empty = valid). `file` is the name the document is stored under. */
export function validateProfile(doc: unknown, file?: string): string[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["profile must be an object"];
  const p = doc as Record<string, unknown>;
  const issues: string[] = [];
  if (p.version !== 1) issues.push("version must be 1");
  if (typeof p.name !== "string" || !MODULE_ID.test(p.name)) issues.push("name must be lowercase letters, digits and dashes");
  else if (file !== undefined && p.name !== file) issues.push(`name "${p.name}" must match the file name "${file}"`);
  if (typeof p.description !== "string" || p.description.length > 300) issues.push("description must be text of at most 300 characters");
  if (!(TARGETS as readonly unknown[]).includes(p.target)) issues.push(`target must be one of ${TARGETS.join(", ")}`);
  const list = (field: string, ok: (v: string) => boolean, hint: string, min = 0): string[] | null => {
    const v = p[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ok(x))) {
      issues.push(`${field} must be a list of ${hint}`);
      return null;
    }
    if (v.length < min) issues.push(`${field} needs at least ${min} entr${min === 1 ? "y" : "ies"}`);
    if (new Set(v).size !== v.length) issues.push(`${field} lists something twice`);
    return v as string[];
  };
  list("build", (x) => WORKSPACE.test(x), "workspace names such as @mmo-engine/engine-core", 1);
  list("bakes", (x) => (BAKES as readonly string[]).includes(x), `bakes (${BAKES.join(", ")})`);
  list("tests", (x) => WORKSPACE.test(x), "workspace names");
  const modules = list("modules", (x) => MODULE_ID.test(x), "module ids", 1);
  if (modules && !modules.includes("core")) issues.push('modules must include "core"');
  const v = p.valgrind as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null) issues.push("valgrind must be an object");
  else {
    if (!Array.isArray(v.memcheck) || v.memcheck.some((x) => typeof x !== "string" || !/^[a-z0-9-]{1,40}$/.test(x))) issues.push("valgrind.memcheck must be a list of addon names");
    for (const f of ["perf", "required"]) if (typeof v[f] !== "boolean") issues.push(`valgrind.${f} must be true or false`);
  }
  if (typeof p.edge !== "boolean") issues.push("edge must be true or false");
  const env = p.env as Record<string, unknown> | null;
  if (typeof env !== "object" || env === null || Array.isArray(env)) issues.push("env must be an object");
  else {
    for (const [k, val] of Object.entries(env)) {
      if (!ENV_KEY.test(k)) issues.push(`env.${k}: only MMO_* and the edge's ports can be set`);
      else if (typeof val !== "string" || val.length > 200 || /[\u0000-\u001f]/.test(val)) issues.push(`env.${k}: must be a short text value`);
      else if (isPortKey(k) && !(/^\d{1,5}$/.test(val) && Number(val) >= 1 && Number(val) <= 65535)) issues.push(`env.${k}: must be a port, 1 to 65535`);
    }
    if (env.MMO_DATA_DIR !== undefined) issues.push("env.MMO_DATA_DIR: the target sets the data folder");
    if (env.MMO_USERS_CSV !== undefined) issues.push("env.MMO_USERS_CSV: the target keeps its own accounts");
  }
  return issues;
}

// ---- pipeline records

export type StepStatus = "pending" | "running" | "passed" | "cached" | "failed" | "skipped";

export interface StepRecord {
  id: StepId;
  label: string;
  status: StepStatus;
  /** Hash of everything the step reads; equal to the cached one means the step is skipped. */
  hash: string;
  startedAt?: number;
  durationMs?: number;
  /** One line: what ran, what was skipped and why. */
  summary: string;
  /** Output lines with the time they arrived. */
  log: Array<{ at: number; line: string }>;
}

export interface RunRecord {
  id: number;
  profile: string;
  commit: string;
  dirty: boolean;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "passed" | "failed" | "cancelled";
  steps: StepRecord[];
  /** The package this run produced, when it got that far. */
  package?: string;
}

export const stepLabel = (id: StepId): string =>
  ({ codegen: "Codegen", build: "Build", "bake:world": "Bake world", "bake:dungeon": "Bake dungeons", "bake:loot": "Bake loot", test: "Tests", valgrind: "Valgrind", package: "Package" })[id];

/** The steps a profile runs, in pipeline order. */
export function stepsFor(p: BuildProfile): StepId[] {
  return STEP_IDS.filter((id) => {
    if (id.startsWith("bake:")) return p.bakes.includes(id.slice(5) as (typeof BAKES)[number]);
    if (id === "test") return p.tests.length > 0;
    if (id === "valgrind") return p.valgrind.memcheck.length > 0 || p.valgrind.perf;
    return true;
  });
}

export interface PackageManifest {
  version: 1;
  name: string;
  profile: string;
  commit: string;
  dirty: boolean;
  builtAt: number;
  /** Input hash of every step that ran for this package. */
  steps: Record<string, string>;
  modules: string[];
  env: Record<string, string>;
  edge: boolean;
  workspaces: string[];
  thirdParty: string[];
  files: number;
  bytes: number;
}

/** What changed between the package on a target and the one about to replace it. */
export function manifestDiff(prev: PackageManifest | null, next: PackageManifest): string[] {
  if (!prev) return ["first deploy to this target"];
  const out: string[] = [];
  if (prev.commit !== next.commit) out.push(`commit ${prev.commit} to ${next.commit}`);
  const mods = (a: string[], b: string[], what: string): void => {
    const added = b.filter((x) => !a.includes(x));
    const gone = a.filter((x) => !b.includes(x));
    if (added.length) out.push(`${what} added: ${added.join(", ")}`);
    if (gone.length) out.push(`${what} removed: ${gone.join(", ")}`);
  };
  mods(prev.modules, next.modules, "modules");
  for (const k of new Set([...Object.keys(prev.env), ...Object.keys(next.env)])) {
    if (prev.env[k] !== next.env[k]) out.push(`${k}: ${prev.env[k] ?? "unset"} to ${next.env[k] ?? "unset"}`);
  }
  if (prev.edge !== next.edge) out.push(next.edge ? "edge added" : "edge removed");
  for (const k of Object.keys(next.steps)) {
    if (prev.steps[k] !== next.steps[k]) out.push(`${k} inputs changed`);
  }
  return out.length ? out : ["no changes"];
}
