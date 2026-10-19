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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { discoverModules, readEnabledSet, resolveModuleSet, type DiscoveredModule, type ResolvedSystem } from "@mmo-engine/modules";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** What a server module's entry receives. */
export interface ServerModuleContext {
  sim: SimWorld;
  log(message: string): void;
  /**
   * Per-module configuration (slice 2). server.ts populates config[name]
   * for modules that need bootstrap data (game rules, data dirs, callbacks).
   * Modules must tolerate absence (sensible defaults or a clear error).
   */
  config?: Record<string, Record<string, unknown>>;
}

export interface AssembleOptions {
  modulesDir: string;
  /** The enabled set document (content/modules.json, or MMO_MODULES). */
  setFile: string;
  /** Instances a module's host process builds itself, by module then system id (undefined = not built this boot). */
  provided: Record<string, Record<string, SimSystem | undefined>>;
  ctx: ServerModuleContext;
  /**
   * Loads a native `.node` entry (EA10). Defaults to node's require via
   * createRequire; tests inject a stub.
   */
  nativeRequire?: (entryPath: string) => unknown;
}

/** What a native (N-API) module entry must export. */
interface NativeModuleExports {
  createSystems?: (ctx: ServerModuleContext) => Record<string, SimSystem> | Promise<Record<string, SimSystem>>;
}

/**
 * Load one native module entry (EA10). Returns the systems it provides and
 * any problems; a missing `.node` file disables the module with a clear
 * error instead of stopping the boot (run `npm run build:native`).
 */
export async function loadNativeModule(
  m: DiscoveredModule,
  ctx: ServerModuleContext,
  requireFn: (entryPath: string) => unknown = createRequire(import.meta.url),
): Promise<{ systems: Record<string, SimSystem>; disabled: boolean; problems: string[] }> {
  const problems: string[] = [];
  const name = m.manifest.name;
  const native = m.manifest.native!;
  const entryPath = join(m.dir, native.entry);
  if (!existsSync(entryPath)) {
    ctx.log(`${name}: native entry "${native.entry}" not found — module disabled. Run \`npm run build:native\` to compile native modules.`);
    return { systems: {}, disabled: true, problems };
  }
  let exports: NativeModuleExports;
  try {
    exports = requireFn(entryPath) as NativeModuleExports;
  } catch (e) {
    problems.push(`${name}: failed to load native entry "${native.entry}": ${(e as Error).message}`);
    return { systems: {}, disabled: true, problems };
  }
  if (typeof exports.createSystems !== "function") {
    problems.push(`${name}: ${native.entry} must export createSystems(ctx)`);
    return { systems: {}, disabled: true, problems };
  }
  const made = (await exports.createSystems(ctx)) as Record<string, SimSystem | undefined>;
  const systems: Record<string, SimSystem> = {};
  for (const d of native.systems) {
    if (!made?.[d]) problems.push(`${name}: ${native.entry} does not provide "${d}"`);
    else systems[d] = made[d]!;
  }
  for (const k of Object.keys(made ?? {})) {
    if (!native.systems.includes(k) && !(m.manifest.server?.systems.some((s) => s.name === k) ?? false) && !(m.manifest.server?.extensions?.includes(k) ?? false)) {
      problems.push(`${name}: provides "${k}", which its manifest does not list`);
    }
  }
  return { systems, disabled: false, problems };
}

const ENGINE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

export async function assembleServerSystems(
  o: AssembleOptions,
): Promise<{
  systems: SimSystem[];
  order: ResolvedSystem[];
  modules: string[];
  byName: Record<string, SimSystem>;
  /**
   * Gateway extensions (manifest `server.extensions`), keyed by extension
   * name. Extensions are NOT tick systems — the gateway consumes them
   * directly (e.g. quests, dungeons). They never enter `systems`/`byName`.
   */
  extensions: Record<string, unknown>;
  /**
   * EA12: edge routes, keyed `local:<module>`. For each enabled module with
   * a manifest `edge` contribution, the route carries its regions, endpoint,
   * and capabilities. Merged into the edge routing table at boot.
   */
  edgeRoutes: Record<string, { regions: string[]; endpoint: string; capabilities: string[] }>;
}> {
  const set = readEnabledSet(o.setFile);
  const found = discoverModules(o.modulesDir, ENGINE_VERSION);
  const lines = [...set.problems, ...found.problems.filter((p) => set.modules.includes(p.module) || p.module === "core")].map(
    (p) => `${p.module}${p.path ? ` ${p.path}` : ""}: ${p.message}`,
  );
  // EA10: a native module whose `.node` file was never built is disabled with
  // a clear error (not a boot-stopping problem) — drop it before resolving
  // so dependents report "not enabled" instead of half-loading.
  const byName = new Map(found.valid.map((m) => [m.manifest.name, m]));
  let enabled = set.modules;
  for (const n of set.modules) {
    const m = byName.get(n);
    if (m?.manifest.native && !existsSync(join(m.dir, m.manifest.native.entry))) {
      o.ctx.log(`${n}: native entry "${m.manifest.native.entry}" not found — module disabled. Run \`npm run build:native\` to compile native modules.`);
      enabled = enabled.filter((x) => x !== n);
    }
  }
  const r = lines.length > 0 ? null : resolveModuleSet(found.valid, enabled);
  if (r === null || !r.ok) {
    const all = r === null ? lines : r.problems.map((p) => `${p.module}${p.path ? ` ${p.path}` : ""}: ${p.message}`);
    throw new Error(`modules: ${all.length} problem${all.length === 1 ? "" : "s"}:\n  ${all.join("\n  ")}`);
  }
  const instances = new Map<string, SimSystem | undefined>();
  const extensionInstances = new Map<string, unknown>();
  const problems: string[] = [];
  const requireFn = o.nativeRequire ?? createRequire(import.meta.url);
  for (const m of r.modules) {
    const name = m.manifest.name;
    const declared = (m.manifest.server?.systems ?? []).map((s) => s.name);
    const optionalSystems = new Set((m.manifest.server?.systems ?? []).filter((s) => s.optional).map((s) => s.name));
    const declaredExtensions = m.manifest.server?.extensions ?? [];
    const declaredNative = m.manifest.native?.systems ?? [];
    let made: Record<string, SimSystem | undefined> | undefined;
    if (m.manifest.server?.entry) {
      const mod = (await import(pathToFileURL(join(m.dir, m.manifest.server.entry)).href)) as {
        createSystems?: (ctx: ServerModuleContext) => Record<string, SimSystem> | Promise<Record<string, SimSystem>>;
      };
      if (typeof mod.createSystems !== "function") problems.push(`${name}: ${m.manifest.server.entry} must export createSystems(ctx)`);
      else {
        made = await mod.createSystems(o.ctx);
        for (const d of declared) if (!made?.[d] && !optionalSystems.has(d)) problems.push(`${name}: ${m.manifest.server.entry} does not provide "${d}"`);
        for (const d of declaredExtensions) if (!made?.[d]) problems.push(`${name}: ${m.manifest.server.entry} does not provide extension "${d}"`);
      }
    } else if (declared.length > 0) {
      made = o.provided[name];
      if (!made) problems.push(`${name}: declares systems but has no server entry and the host provides none`);
    }
    if (m.manifest.native) {
      const native = await loadNativeModule(m, o.ctx, requireFn);
      problems.push(...native.problems);
      made = { ...(made ?? {}), ...native.systems };
    }
    for (const k of Object.keys(made ?? {})) {
      if (!declared.includes(k) && !declaredNative.includes(k) && !declaredExtensions.includes(k))
        problems.push(`${name}: provides "${k}", which its manifest does not list`);
    }
    for (const d of declared) instances.set(d, made?.[d]);
    for (const d of declaredNative) instances.set(d, made?.[d]);
    for (const d of declaredExtensions) extensionInstances.set(d, made?.[d]);
  }
  if (problems.length > 0) throw new Error(`modules: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  const order = r.systems.filter((s) => instances.get(s.name) !== undefined);
  const systemsByName: Record<string, SimSystem> = {};
  for (const [k, v] of instances) if (v !== undefined) systemsByName[k] = v;
  const extensions: Record<string, unknown> = {};
  for (const [k, v] of extensionInstances) if (v !== undefined) extensions[k] = v;
  // EA12: merge `local:<module>` routes for enabled modules with edge contributions.
  const edgeRoutes: Record<string, { regions: string[]; endpoint: string; capabilities: string[] }> = {};
  for (const m of r.modules) {
    const edge = m.manifest.edge;
    if (edge) {
      edgeRoutes[`local:${m.manifest.name}`] = {
        regions: edge.regions,
        endpoint: edge.endpoint,
        capabilities: edge.capabilities,
      };
    }
  }
  return { systems: order.map((s) => instances.get(s.name)!), order, modules: r.modules.map((m) => m.manifest.name), byName: systemsByName, extensions, edgeRoutes };
}
