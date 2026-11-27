/**
 * The game manifest for the editor dev host (roadmap EB10).
 *
 * Loopback routes (wired in host.ts), same posture as modules-host.ts:
 *
 *   GET    /api/editor/game  → the manifest as written (or that there is none),
 *                              with every enabled module's declared settings
 *   POST   /api/editor/game  → create `game.json`; refused if one is there
 *   PUT    /api/editor/game  → validate with the SDK's own schema, then write
 *
 * Three things this deliberately does not do. It never writes a manifest
 * as a side effect of being asked to read one: creating a `game.json`
 * turns a checkout into a game project, which changes how every path
 * resolves at boot, and that is a decision somebody makes on purpose.
 * It never overwrites an existing manifest with a new one — POST answers
 * 409 and the editor edits the file that is there instead. And it adds
 * no keys of its own: the document is checked by `GameManifestSchema`
 * from `@mmo-engine/sdk`, the same strict schema the server boots with,
 * so the editor cannot write a manifest the engine would refuse.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverModules, readEnabledSet, type SettingSpec } from "@mmo-engine/modules";
import { failureReply, invalidMessage, jsonBodyField, type RouteReply } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";
import { packageModule } from "./content-docs-host.js";
import { setFilePath } from "./modules-host.js";
import type { RulesIssue } from "./rules-control.js";

export const GAME_MANIFEST_FILE = "game.json";

export const manifestPath = (repoRoot: string): string => join(resolve(repoRoot), GAME_MANIFEST_FILE);

/** What a module says it reads from the manifest, for the form to draw. */
export interface ModuleSettings {
  module: string;
  enabled: boolean;
  settings: readonly SettingSpec[];
  /** Keys the manifest sets that the module never declared (still valid; shown as they are). */
  undeclared: readonly string[];
}

/** The manifest as written, or undefined when the game has none. */
export function readManifest(repoRoot: string): unknown {
  const file = manifestPath(repoRoot);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/**
 * Every module that could be configured, with what it declares. Modules
 * come from discovery and the enabled set, never from the manifest, so a
 * stale `modules` block cannot invent a module; its keys show up as
 * undeclared settings on the module they name.
 */
export function moduleSettings(repoRoot: string, manifest: unknown): ModuleSettings[] {
  const found = discoverModules(join(repoRoot, "modules"));
  const enabled = new Set(readEnabledSet(setFilePath(repoRoot)).modules);
  const configured = (manifest as { modules?: Record<string, Record<string, unknown>> } | undefined)?.modules ?? {};
  const rows = found.valid.map((m) => {
    const declared = m.manifest.settings ?? [];
    const keys = new Set(declared.map((s) => s.key));
    return {
      module: m.manifest.name,
      enabled: m.manifest.name === "core" || enabled.has(m.manifest.name),
      settings: declared,
      undeclared: Object.keys(configured[m.manifest.name] ?? {}).filter((k) => !keys.has(k)),
    };
  });
  // A module the manifest configures that no longer exists is worth
  // seeing rather than dropping: its settings are dead weight in the file.
  for (const name of Object.keys(configured)) {
    if (!rows.some((r) => r.module === name)) {
      rows.push({ module: name, enabled: false, settings: [], undeclared: Object.keys(configured[name]) });
    }
  }
  return rows.sort((a, b) => a.module.localeCompare(b.module));
}

/** The SDK's own schema, so the editor and the boot agree on what a manifest is. */
async function manifestIssues(repoRoot: string, content: unknown): Promise<RulesIssue[]> {
  const schema = (await packageModule(repoRoot, "sdk", "manifest.js")).GameManifestSchema as {
    safeParse(v: unknown): { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  };
  const r = schema.safeParse(content);
  return r.success ? [] : r.error.issues.map((i) => ({ file: GAME_MANIFEST_FILE, path: i.path.map(String).join("."), message: i.message }));
}

/** A new manifest: the name, an optional description, and nothing else. */
export function newManifest(name: string, description?: string): Record<string, unknown> {
  return { name, ...(description && description.trim().length > 0 ? { description: description.trim() } : {}) };
}

/** A field of the request body that may legitimately be absent. */
function optionalField(body: string | undefined, key: string): unknown {
  try {
    const parsed = JSON.parse(body ?? "") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

export async function handleGameRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): Promise<RouteReply | null> {
  if (pathname !== "/api/editor/game") return null;
  const file = manifestPath(repoRoot);
  try {
    return await route(repoRoot, method, body, file);
  } catch (e) {
    return failureReply(e);
  }
}

async function route(repoRoot: string, method: string, body: string | undefined, file: string): Promise<RouteReply> {

  if (method === "GET") {
    let manifest: unknown;
    try {
      manifest = readManifest(repoRoot);
    } catch (e) {
      return { status: 200, body: { ok: true, exists: true, file, manifest: null, error: `${GAME_MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`, modules: moduleSettings(repoRoot, undefined) } };
    }
    return { status: 200, body: { ok: true, exists: manifest !== undefined, file, manifest: manifest ?? null, modules: moduleSettings(repoRoot, manifest) } };
  }

  if (method === "POST") {
    if (existsSync(file)) {
      return { status: 409, body: { ok: false, error: `${GAME_MANIFEST_FILE} is already there — edit it instead` } };
    }
    const name = jsonBodyField(body, "name");
    if (typeof name !== "string" || name.trim().length === 0) {
      return { status: 400, body: { ok: false, error: "a game needs a name" } };
    }
    const description = optionalField(body, "description");
    const manifest = newManifest(name.trim(), typeof description === "string" ? description : undefined);
    const issues = await manifestIssues(repoRoot, manifest);
    if (issues.length > 0) return { status: 400, body: { ok: false, error: invalidMessage(GAME_MANIFEST_FILE, issues.length), issues } };
    writeJsonAtomic(file, manifest);
    return { status: 200, body: { ok: true, exists: true, created: true, file, manifest, modules: moduleSettings(repoRoot, manifest) } };
  }

  if (method === "PUT") {
    const manifest = jsonBodyField(body, "manifest");
    const issues = await manifestIssues(repoRoot, manifest);
    if (issues.length > 0) return { status: 400, body: { ok: false, error: invalidMessage(GAME_MANIFEST_FILE, issues.length), issues } };
    writeJsonAtomic(file, manifest);
    return { status: 200, body: { ok: true, exists: true, file, manifest, modules: moduleSettings(repoRoot, manifest) } };
  }

  return { status: 405, body: { ok: false, error: "use GET, POST or PUT" } };
}
