/**
 * Server modules (roadmap EA9): the tick's systems array, assembled from the
 * enabled module set at boot.
 *
 * `core` contributes server.ts's own instances (`provided.core`, keyed by the
 * ids in modules/core/module.json, which also fixes their order). Any other
 * enabled module has a `server.entry` (.js/.mjs) exporting
 * `createSystems(ctx)` that returns one SimSystem per name its manifest
 * declares. `@mmo-engine/modules` resolves one order from `after` / `before`;
 * any problem (unknown id, cycle, missing instance) throws with every line
 * listed, so a bad set stops the boot instead of running half a game.
 *
 * Boot-time only: the result is the same plain array the gateway always got.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverModules, readEnabledSet, resolveModuleSet, type ResolvedSystem } from "@mmo-engine/modules";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** What a server module's entry receives. */
export interface ServerModuleContext {
  sim: SimWorld;
  log(message: string): void;
}

export interface AssembleOptions {
  modulesDir: string;
  /** The enabled set document (content/modules.json, or MMO_MODULES). */
  setFile: string;
  /** Instances a module's host process builds itself, by module then system id (undefined = not built this boot). */
  provided: Record<string, Record<string, SimSystem | undefined>>;
  ctx: ServerModuleContext;
}

const ENGINE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export async function assembleServerSystems(
  o: AssembleOptions,
): Promise<{ systems: SimSystem[]; order: ResolvedSystem[]; modules: string[] }> {
  const set = readEnabledSet(o.setFile);
  const found = discoverModules(o.modulesDir, ENGINE_VERSION);
  const lines = [...set.problems, ...found.problems.filter((p) => set.modules.includes(p.module) || p.module === "core")].map(
    (p) => `${p.module}${p.path ? ` ${p.path}` : ""}: ${p.message}`,
  );
  const r = lines.length > 0 ? null : resolveModuleSet(found.valid, set.modules);
  if (r === null || !r.ok) {
    const all = r === null ? lines : r.problems.map((p) => `${p.module}${p.path ? ` ${p.path}` : ""}: ${p.message}`);
    throw new Error(`modules: ${all.length} problem${all.length === 1 ? "" : "s"}:\n  ${all.join("\n  ")}`);
  }
  const instances = new Map<string, SimSystem | undefined>();
  const problems: string[] = [];
  for (const m of r.modules) {
    const name = m.manifest.name;
    const declared = (m.manifest.server?.systems ?? []).map((s) => s.name);
    let made: Record<string, SimSystem | undefined> | undefined;
    if (m.manifest.server?.entry) {
      const mod = (await import(pathToFileURL(join(m.dir, m.manifest.server.entry)).href)) as {
        createSystems?: (ctx: ServerModuleContext) => Record<string, SimSystem> | Promise<Record<string, SimSystem>>;
      };
      if (typeof mod.createSystems !== "function") problems.push(`${name}: ${m.manifest.server.entry} must export createSystems(ctx)`);
      else {
        made = await mod.createSystems(o.ctx);
        for (const d of declared) if (!made?.[d]) problems.push(`${name}: ${m.manifest.server.entry} does not provide "${d}"`);
      }
    } else if (declared.length > 0) {
      made = o.provided[name];
      if (!made) problems.push(`${name}: declares systems but has no server entry and the host provides none`);
    }
    for (const k of Object.keys(made ?? {})) if (!declared.includes(k)) problems.push(`${name}: provides "${k}", which its manifest does not list`);
    for (const d of declared) instances.set(d, made?.[d]);
  }
  if (problems.length > 0) throw new Error(`modules: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  const order = r.systems.filter((s) => instances.get(s.name) !== undefined);
  return { systems: order.map((s) => instances.get(s.name)!), order, modules: r.modules.map((m) => m.manifest.name) };
}
