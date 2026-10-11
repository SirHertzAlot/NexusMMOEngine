/**
 * Module management for the editor dev host (roadmap EA3 / EA9).
 *
 * Loopback routes (wired in host.ts), same posture as scenes-host.ts:
 *
 *   GET  /api/editor/modules        → modules, the enabled set, the tick order it resolves to,
 *                                     and the running play server's tick order
 *   PUT  /api/editor/modules        → { enabled: [...] } → validate + resolve, then write content/modules.json
 *   POST /api/editor/modules/apply  → restart the owned play server with the saved set
 *
 * - Module names come from discovery (`modules/<name>/module.json`), never from
 *   the request as a path; the set file is always <repo>/content/modules.json.
 * - A save is resolved first (unknown or invalid module, missing dependency,
 *   unknown system id, cycle); a refused save answers 400 with every problem
 *   and writes nothing. `core` is always on and written first.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export async function handleModulesRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
  hooks: ModulesHooks,
): Promise<ModulesRouteResult | null> {
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
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        invalid: found.invalid,
        enabled: set.modules,
        problems: [...set.problems, ...(resolved.ok ? [] : resolved.problems)],
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
    if (!resolved.ok) return issues(resolved.problems);
    mkdirSync(join(repoRoot, "content"), { recursive: true });
    const file = setFilePath(repoRoot);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ modules: names }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { status: 200, body: { ok: true, enabled: names, tickOrder: resolved.systems.map((s) => s.name) } };
  }
  return { status: 405, body: { ok: false, error: "use GET or PUT" } };
}
