/**
 * Module management for the editor dev host (roadmap EA3 / EA9).
 *
 * Loopback routes (wired in host.ts), same posture as scenes-host.ts:
 *
 *   GET  /api/editor/modules        → modules, the enabled set, the tick order it resolves to,
 *                                     and the running play server's tick order
 *   PUT  /api/editor/modules        → { enabled: [...] } → validate + resolve, then write content/modules.json
 *   POST /api/editor/modules/apply  → restart the owned play server with the saved set
 *   POST /api/editor/modules/:name/build → (EA10) build the module's native addon via node-gyp
 *   GET  /api/editor/modules/:name/check → (EA10) check if the module's native addon is built
 *
 * - Module names come from discovery (`modules/<name>/module.json`), never from
 *   the request as a path; the set file is always <repo>/content/modules.json.
 * - A save is resolved first (unknown or invalid module, missing dependency,
 *   unknown system id, cycle); a refused save answers 400 with every problem
 *   and writes nothing. `core` is always on and written first.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverModules, readEnabledSet, resolveModuleSet, type Problem } from "@mmo-engine/modules";
import { invalidMessage } from "./api.js";

export interface ModulesHooks {
  /** The running owned server's tick order, null when none is running or it has not reported one. */
  running(): string[] | null;
  /** Restart the owned play server with the saved set. */
  apply(): Promise<Record<string, unknown>>;
}
export interface ModulesRouteResult {
  status: number;
  body: unknown;
}

const BASE = "/api/editor/modules";

export const setFilePath = (repoRoot: string): string => join(repoRoot, "content", "modules.json");

/** The server logs `[modules] a, b | tick order: x y z` at boot. */
export function parseTickOrder(output: string): string[] | null {
  const m = [...output.matchAll(/\[modules\] .*\| tick order: (.*)/g)].pop();
  return m ? m[1].trim().split(/\s+/) : null;
}

const execFileAsync = promisify(execFile);

/**
 * EA10: check if a module's native addon is built.
 * Returns the .node file path if built, null otherwise.
 */
function nativeAddonPath(repoRoot: string, moduleName: string): string | null {
  // Native modules live in packages/addons/<name> or modules/<name>/native.
  // The manifest's native.entry points to the .node file.
  const found = discoverModules(join(repoRoot, "modules"));
  const mod = found.valid.find((m) => m.manifest.name === moduleName);
  const entry = mod?.manifest.native?.entry;
  if (!entry) return null;
  const full = join(mod.dir, entry);
  return existsSync(full) ? full : null;
}

/**
 * EA10: handle POST /api/editor/modules/:name/build and GET :name/check.
 * Build runs node-gyp rebuild in the module's dir; check reports whether
 * the .node file exists.
 */
async function handleNativeRoute(
  repoRoot: string,
  name: string,
  action: string,
  method: string,
): Promise<ModulesRouteResult> {
  const found = discoverModules(join(repoRoot, "modules"));
  const mod = found.valid.find((m) => m.manifest.name === name);
  if (!mod) {
    return { status: 404, body: { ok: false, error: `unknown module: ${name}` } };
  }
  if (!mod.manifest.native) {
    return { status: 400, body: { ok: false, error: `module ${name} has no native addon` } };
  }

  if (action === "check") {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "use GET" } };
    const built = nativeAddonPath(repoRoot, name);
    return {
      status: 200,
      body: { ok: true, name, built: built !== null, path: built },
    };
  }

  // action === "build"
  if (method !== "POST") return { status: 405, body: { ok: false, error: "use POST" } };
  // The native entry lives in packages/addons/<name> for shared addons,
  // or in the module dir itself. Find the dir containing binding.gyp.
  const candidates = [mod.dir, join(repoRoot, "packages", "addons", name)];
  let buildDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(join(c, "binding.gyp"))) {
      buildDir = c;
      break;
    }
  }
  if (!buildDir) {
    return { status: 400, body: { ok: false, error: `no binding.gyp found for ${name}` } };
  }
  try {
    // node-gyp rebuild: clean + configure + build.
    const { stdout, stderr } = await execFileAsync("npx", ["node-gyp", "rebuild"], {
      cwd: buildDir,
      timeout: 300_000, // 5 min max for native builds
    });
    const built = nativeAddonPath(repoRoot, name);
    return {
      status: 200,
      body: { ok: true, name, built: built !== null, path: built, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) },
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      status: 500,
      body: {
        ok: false,
        error: `build failed: ${err.message ?? String(e)}`,
        stdout: (err.stdout ?? "").slice(-2000),
        stderr: (err.stderr ?? "").slice(-2000),
      },
    };
  }
}

export async function handleModulesRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
  hooks: ModulesHooks,
): Promise<ModulesRouteResult | null> {
  // EA10: native build/check routes: /api/editor/modules/:name/build and :name/check.
  const nativeMatch = pathname.match(new RegExp(`^${BASE}/([^/]+)/(build|check)$`));
  if (nativeMatch) {
    const [, name, action] = nativeMatch;
    return handleNativeRoute(repoRoot, name, action, method);
  }
  if (pathname !== BASE && pathname !== `${BASE}/apply`) return null;
  const modulesDir = join(repoRoot, "modules");
  const issues = (problems: Problem[]): ModulesRouteResult => ({
    status: 400,
    body: { ok: false, error: invalidMessage("module set", problems.length), issues: problems },
  });

  if (pathname === `${BASE}/apply`) {
    if (method !== "POST") return { status: 405, body: { ok: false, error: "use POST" } };
    try {
      return { status: 200, body: { ok: true, ...(await hooks.apply()) } };
    } catch (e) {
      return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
  }

  const found = discoverModules(modulesDir);
  if (method === "GET") {
    const set = readEnabledSet(setFilePath(repoRoot));
    const resolved = resolveModuleSet(found.valid, set.modules);
    const live = new Set(resolved.ok ? resolved.modules.map((m) => m.manifest.name) : set.modules);
    return {
      status: 200,
      body: {
        ok: true,
        modules: found.valid
          .map((m) => ({
            name: m.manifest.name,
            version: m.manifest.version,
            description: m.manifest.description ?? "",
            dependsOn: m.manifest.dependsOn ?? [],
            enabled: m.manifest.name === "core" || live.has(m.manifest.name),
            locked: m.manifest.name === "core",
            editor: m.manifest.editor !== undefined,
            systems: (m.manifest.server?.systems ?? []).map((s) => s.name),
            sidecar: m.manifest.sidecar !== undefined,
            // EA10: native addon info for Build/Check buttons.
            native: m.manifest.native
              ? { entry: m.manifest.native.entry, systems: m.manifest.native.systems }
              : undefined,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        invalid: found.invalid,
        enabled: set.modules,
        problems: [...set.problems, ...(resolved.ok ? [] : (resolved as { ok: false; problems: Problem[] }).problems)],
        tickOrder: resolved.ok ? resolved.systems.map((s) => s.name) : null,
        running: hooks.running() ? { systems: hooks.running() } : null,
      },
    };
  }

  if (method === "PUT") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? "") as unknown;
    } catch {
      return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
    }
    const enabled = (parsed as { enabled?: unknown } | null)?.enabled;
    if (!Array.isArray(enabled) || enabled.some((n) => typeof n !== "string")) {
      return issues([{ module: "modules.json", path: "enabled", message: "must be a list of module names" }]);
    }
    const names = ["core", ...new Set((enabled as string[]).filter((n) => n !== "core"))];
    const resolved = resolveModuleSet(found.valid, names);
    if (!resolved.ok) return issues((resolved as { ok: false; problems: Problem[] }).problems);
    mkdirSync(join(repoRoot, "content"), { recursive: true });
    const file = setFilePath(repoRoot);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ modules: names }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { status: 200, body: { ok: true, enabled: names, tickOrder: resolved.systems.map((s) => s.name) } };
  }
  return { status: 405, body: { ok: false, error: "use GET or PUT" } };
}
