/**
 * Module manifests (roadmap EA3 / EA9, EDITOR-ARCHITECTURE.md section 4).
 *
 * A module is a folder `modules/<name>/` with a `module.json`. This package
 * is pure data handling, shared by the editor host (list, enable, disable)
 * and engine-core (resolve the server system order at boot):
 *
 *   validateManifest   every problem at once, unknown keys refused
 *   discoverModules    list modules/<name>/module.json, valid and invalid
 *   readEnabledSet     content/modules.json -> { modules: [...] }
 *   resolveModuleSet   dependency order + one tick order from after/before
 *
 * Nothing here runs on the tick: the order is resolved once at boot.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SystemSpec {
  name: string;
  after?: string[];
  before?: string[];
}
export interface ModuleManifest {
  name: string;
  version: string;
  description?: string;
  /** Engine version range: ">=x.y.z" or an exact "x.y.z". */
  engine?: string;
  dependsOn?: string[];
  /** Editor contribution: a module the shell imports dynamically. */
  editor?: { entry: string };
  /**
   * Server contribution. `entry` (a .js/.mjs file exporting `createSystems`)
   * builds the instances; without one the host process provides them (the
   * `core` module, whose systems server.ts constructs).
   */
  server?: { entry?: string; systems: SystemSpec[] };
  /**
   * Native contribution (EA10). `entry` is a compiled N-API `.node` file
   * exporting `createSystems`. The host loads it via require().
   */
  native?: { entry: string; systems: string[] };
  /**
   * Sidecar contribution (EA11). A helper process run alongside the server.
   * `command` starts it; `health` is polled for readiness.
   */
  sidecar?: { command: string; port: number; health: string };
}
export interface Problem {
  module: string;
  path: string;
  message: string;
}
export interface DiscoveredModule {
  dir: string;
  manifest: ModuleManifest;
}
export interface InvalidModule {
  name: string;
  problems: Problem[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ENTRY_RE = /^(?!\/)(?!.*\.\.)(?![A-Za-z]:)[\w./-]+\.(?:js|mjs|ts|tsx|jsx)$/;

const cmp = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate one manifest; `dirName` is the folder it lives in (the name must match). */
export function validateManifest(
  raw: unknown,
  dirName: string,
  engineVersion?: string,
): { manifest?: ModuleManifest; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (path: string, message: string): void => void problems.push({ module: dirName, path, message });
  if (!isObj(raw)) {
    bad("", "manifest must be a JSON object");
    return { problems };
  }
  const only = (o: Record<string, unknown>, keys: string[], at: string): void => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(at ? `${at}.${k}` : k, `unknown key "${k}"`);
  };
  only(raw, ["name", "version", "description", "engine", "dependsOn", "editor", "server"], "");
  if (typeof raw.name !== "string" || !NAME_RE.test(raw.name)) bad("name", "must be lowercase letters, digits and dashes, starting with a letter");
  else if (raw.name !== dirName) bad("name", `must match the folder name "${dirName}"`);
  if (typeof raw.version !== "string" || !SEMVER_RE.test(raw.version)) bad("version", 'must be "major.minor.patch"');
  if (raw.description !== undefined && typeof raw.description !== "string") bad("description", "must be a string");
  if (raw.engine !== undefined) {
    const m = typeof raw.engine === "string" ? /^(>=)?(\d+\.\d+\.\d+)$/.exec(raw.engine) : null;
    if (!m) bad("engine", 'must be ">=x.y.z" or "x.y.z"');
    else if (engineVersion && (m[1] ? cmp(engineVersion, m[2]) < 0 : cmp(engineVersion, m[2]) !== 0)) {
      bad("engine", `needs engine ${raw.engine as string}, this is ${engineVersion}`);
    }
  }
  let dependsOn: string[] | undefined;
  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== "string" || !NAME_RE.test(d))) bad("dependsOn", "must be a list of module names");
    else dependsOn = raw.dependsOn as string[];
  }
  const entry = (o: Record<string, unknown>, at: string): string | undefined => {
    if (o.entry === undefined) return undefined;
    if (typeof o.entry !== "string" || !ENTRY_RE.test(o.entry)) {
      bad(`${at}.entry`, "must be a relative path inside the module to a .js, .mjs, .ts, .tsx or .jsx file");
      return undefined;
    }
    return o.entry;
  };
  let editor: ModuleManifest["editor"];
  if (raw.editor !== undefined) {
    if (!isObj(raw.editor)) bad("editor", "must be an object");
    else {
      only(raw.editor, ["entry"], "editor");
      const e = entry(raw.editor, "editor");
      if (raw.editor.entry === undefined) bad("editor.entry", "required");
      else if (e) editor = { entry: e };
    }
  }
  let server: ModuleManifest["server"];
  if (raw.server !== undefined) {
    if (!isObj(raw.server)) bad("server", "must be an object");
    else {
      only(raw.server, ["entry", "systems"], "server");
      const e = entry(raw.server, "server");
      const systems: SystemSpec[] = [];
      if (!Array.isArray(raw.server.systems)) bad("server.systems", "must be a list");
      else {
        const seen = new Set<string>();
        raw.server.systems.forEach((s: unknown, i: number) => {
          const at = `server.systems[${i}]`;
          if (!isObj(s)) return bad(at, "must be an object");
          only(s, ["name", "after", "before"], at);
          if (typeof s.name !== "string" || !NAME_RE.test(s.name)) bad(`${at}.name`, "must be lowercase letters, digits and dashes");
          else if (seen.has(s.name)) bad(`${at}.name`, `"${s.name}" is listed twice`);
          else seen.add(s.name);
          const refs = (k: "after" | "before"): string[] | undefined => {
            const v = s[k];
            if (v === undefined) return undefined;
            const list = typeof v === "string" ? [v] : v;
            if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
              bad(`${at}.${k}`, "must be a system name or a list of them");
              return undefined;
            }
            return list as string[];
          };
          const spec: SystemSpec = { name: String(s.name) };
          const after = refs("after");
          const before = refs("before");
          if (after) spec.after = after;
          if (before) spec.before = before;
          systems.push(spec);
        });
      }
      server = { ...(e ? { entry: e } : {}), systems };
    }
  }
  if (problems.length > 0) return { problems };
  return {
    manifest: {
      name: raw.name as string,
      version: raw.version as string,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.engine === "string" ? { engine: raw.engine } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(editor ? { editor } : {}),
      ...(server ? { server } : {}),
    },
    problems,
  };
}

/** List `<modulesDir>/<name>/module.json`. A folder without a manifest is not a module. */
export function discoverModules(
  modulesDir: string,
  engineVersion?: string,
): { valid: DiscoveredModule[]; invalid: InvalidModule[]; problems: Problem[] } {
  const valid: DiscoveredModule[] = [];
  const invalid: InvalidModule[] = [];
  if (!existsSync(modulesDir)) return { valid, invalid, problems: [] };
  for (const d of readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const file = join(modulesDir, d, "module.json");
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (e) {
      invalid.push({ name: d, problems: [{ module: d, path: "", message: `module.json is not valid JSON: ${(e as Error).message}` }] });
      continue;
    }
    const r = validateManifest(raw, d, engineVersion);
    if (r.manifest) valid.push({ dir: join(modulesDir, d), manifest: r.manifest });
    else invalid.push({ name: d, problems: r.problems });
  }
  return { valid, invalid, problems: invalid.flatMap((i) => i.problems) };
}

/** Validate a set document (`{ "modules": [...] }`). */
export function validateEnabledSet(raw: unknown): { modules: string[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (path: string, message: string): void => void problems.push({ module: "modules.json", path, message });
  if (!isObj(raw)) {
    bad("", "must be a JSON object");
    return { modules: ["core"], problems };
  }
  for (const k of Object.keys(raw)) if (k !== "modules") bad(k, `unknown key "${k}"`);
  let modules = ["core"];
  if (!Array.isArray(raw.modules) || raw.modules.some((m) => typeof m !== "string" || !NAME_RE.test(m))) bad("modules", "must be a list of module names");
  else modules = [...new Set(raw.modules as string[])];
  return { modules, problems };
}

/** Read the enabled set; a missing file means core only. */
export function readEnabledSet(file: string): { modules: string[]; problems: Problem[] } {
  if (!existsSync(file)) return { modules: ["core"], problems: [] };
  try {
    return validateEnabledSet(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (e) {
    return { modules: ["core"], problems: [{ module: "modules.json", path: "", message: `not valid JSON: ${(e as Error).message}` }] };
  }
}

export interface ResolvedSystem {
  name: string;
  module: string;
}
export type Resolution =
  | { ok: true; modules: DiscoveredModule[]; systems: ResolvedSystem[] }
  | { ok: false; problems: Problem[] };

/**
 * Resolve an enabled set against the discovered modules: `core` first, then
 * dependencies before dependents (ties: the set's order), and one system
 * order. Within a module its systems run in the listed order (each is
 * implicitly after the one above it); `after` / `before` add edges across
 * modules. Among systems the constraints leave free, declaration order wins,
 * so the core module alone reproduces its list exactly. Every problem is
 * returned; nothing partial is.
 */
export function resolveModuleSet(valid: DiscoveredModule[], enabled: string[]): Resolution {
  const problems: Problem[] = [];
  const byName = new Map(valid.map((m) => [m.manifest.name, m]));
  const want = ["core", ...enabled.filter((n) => n !== "core")];
  for (const n of want) if (!byName.has(n)) problems.push({ module: n, path: "", message: n === "core" ? 'the "core" module is missing' : `module "${n}" is not installed or its manifest is invalid` });
  if (problems.length > 0) return { ok: false, problems };

  const modules: DiscoveredModule[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (n: string, trail: string[]): void => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting") {
      problems.push({ module: n, path: "dependsOn", message: `dependency cycle: ${[...trail.slice(trail.indexOf(n)), n].join(" -> ")}` });
      return;
    }
    state.set(n, "visiting");
    for (const d of byName.get(n)!.manifest.dependsOn ?? []) {
      if (!byName.has(d)) problems.push({ module: n, path: "dependsOn", message: `requires "${d}", which is not installed` });
      else if (!want.includes(d)) problems.push({ module: n, path: "dependsOn", message: `requires "${d}", which is not enabled` });
      else visit(d, [...trail, n]);
    }
    state.set(n, "done");
    modules.push(byName.get(n)!);
  };
  for (const n of want) visit(n, []);
  if (problems.length > 0) return { ok: false, problems };

  const nodes: ResolvedSystem[] = [];
  const index = new Map<string, number>();
  for (const m of modules) {
    for (const s of m.manifest.server?.systems ?? []) {
      if (index.has(s.name)) problems.push({ module: m.manifest.name, path: "server.systems", message: `system "${s.name}" already exists in module "${nodes[index.get(s.name)!].module}"` });
      else {
        index.set(s.name, nodes.length);
        nodes.push({ name: s.name, module: m.manifest.name });
      }
    }
  }
  const preds: Set<number>[] = nodes.map(() => new Set());
  const edge = (from: number, to: number): void => void preds[to].add(from);
  for (const m of modules) {
    const list = m.manifest.server?.systems ?? [];
    list.forEach((s, i) => {
      const me = index.get(s.name);
      if (me === undefined) return;
      if (i > 0 && index.get(list[i - 1].name) !== undefined) edge(index.get(list[i - 1].name)!, me);
      for (const [refs, forward] of [[s.after, true], [s.before, false]] as const) {
        for (const r of refs ?? []) {
          const other = index.get(r);
          if (other === undefined) problems.push({ module: m.manifest.name, path: `server.systems.${s.name}.${forward ? "after" : "before"}`, message: `system "${s.name}" is ${forward ? "after" : "before"} "${r}", which no enabled module declares` });
          else if (forward) edge(other, me);
          else edge(me, other);
        }
      }
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  // Kahn's algorithm, always taking the lowest declaration index that is ready.
  const placed: number[] = [];
  const done = new Set<number>();
  while (placed.length < nodes.length) {
    let next = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!done.has(i) && [...preds[i]].every((p) => done.has(p))) {
        next = i;
        break;
      }
    }
    if (next < 0) {
      // Every unplaced system waits on another: walk predecessors until one repeats.
      let at = nodes.findIndex((_, i) => !done.has(i));
      const walk: number[] = [];
      while (!walk.includes(at)) {
        walk.push(at);
        at = [...preds[at]].find((p) => !done.has(p))!;
      }
      const cycle = walk.slice(walk.indexOf(at)).reverse().map((i) => nodes[i].name);
      return { ok: false, problems: [{ module: nodes[at].module, path: "server.systems", message: `system order cycle: ${[...cycle, cycle[0]].join(" -> ")}` }] };
    }
    done.add(next);
    placed.push(next);
  }
  return { ok: true, modules, systems: placed.map((i) => nodes[i]) };
}
