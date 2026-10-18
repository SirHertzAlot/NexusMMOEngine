/**
 * Designer settings documents for the editor dev host: one fixed file under
 * `<repo>/content` per name, validated with the schema the game loads it
 * with. Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/docs/<name> → { ok, content }      the file as written
 *   PUT /api/editor/docs/<name> → { content }          validate, then write
 *
 * `<name>` is a key of CONTENT_DOC_FILES (content-docs.ts), so there is no path to confine. A
 * refused save answers 400 with every issue ({ file, path, message }, the
 * Rules panel's shape) and writes nothing.
 *
 * A document another view also edits names the keys its form owns
 * (CONTENT_DOC_KEYS): a save replaces only those on what is on disk, so
 * saving the form never undoes a save from the other view.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";
import { CONTENT_DOC_FILES, isContentDoc, type ContentDocName } from "./content-docs.js";
import type { RulesIssue } from "./rules-control.js";

/** The slice of a zod schema the checks use. */
interface Schema {
  safeParse(v: unknown): { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

export interface ContentDoc {
  /** Every problem with `content` as this document (empty: valid). */
  check: (repoRoot: string, content: unknown) => Promise<RulesIssue[]>;
}

const modules = new Map<string, Promise<Record<string, unknown>>>();

/** A module of a package's build (`packages/<pkg>/dist/src/<rel>`), loaded once per repo. */
export function packageModule(repoRoot: string, pkg: string, rel: string): Promise<Record<string, unknown>> {
  const key = `${repoRoot}|${pkg}|${rel}`;
  let p = modules.get(key);
  if (!p) {
    const file = join(repoRoot, "packages", pkg, "dist", "src", rel);
    p = import(pathToFileURL(file).href).catch((e: unknown) => {
      modules.delete(key);
      throw Object.assign(new Error(`${pkg}'s ${rel} isn't built (npm run build -w @mmo-engine/${pkg}): ${(e as Error).message}`), { status: 500 });
    }) as Promise<Record<string, unknown>>;
    modules.set(key, p);
  }
  return p;
}

/** A module of engine-core's build (`packages/engine-core/dist/src/<rel>`). */
export const engineModule = (repoRoot: string, rel: string): Promise<Record<string, unknown>> => packageModule(repoRoot, "engine-core", rel);

/** A zod schema's issues as the Rules panel shows them, under `<doc>.json`. */
export function schemaIssues(doc: string, schema: Schema, content: unknown): RulesIssue[] {
  const r = schema.safeParse(content);
  return r.success ? [] : r.error.issues.map((i) => ({ file: `${doc}.json`, path: i.path.map(String).join("."), message: i.message }));
}

/** A document checked by an engine-core schema export (`<rel>`'s `<name>`). */
const engineSchema = (doc: string, rel: string, name: string): ContentDoc["check"] => async (repoRoot, content) =>
  schemaIssues(doc, (await engineModule(repoRoot, rel))[name] as Schema, content);

/** Each document's check (its file is CONTENT_DOC_FILES'). */
export const CONTENT_DOC_CHECKS: Record<ContentDocName, ContentDoc["check"]> = {
  instances: engineSchema("instances", "dungeons/content.js", "InstanceRulesSchema"),
  entrances: engineSchema("entrances", "dungeons/content.js", "EntrancesSchema"),
  // The crafting package's own check: shape, then every material is a known raw material.
  crafting: async (repoRoot, content) => {
    const check = (await packageModule(repoRoot, "crafting", "index.js")).checkCraftingRules as (json: unknown) => Array<{ path: string; message: string }>;
    return check(content).map((i) => ({ file: "crafting.json", path: i.path, message: i.message }));
  },
  // The art package's budget schema: every tier, positive counts, higher tiers never fewer particles.
  persistence: engineSchema("persistence", "server-settings.js", "PersistenceSettingsSchema"),
  vfxBudgets: async (repoRoot, content) => schemaIssues("vfxBudgets", (await packageModule(repoRoot, "art", "particle-budgets.js")).ParticleBudgets as Schema, content),
};

/** The keys a document's form owns, when another view edits the rest of its file. */
export const CONTENT_DOC_KEYS: Partial<Record<ContentDocName, readonly string[]>> = {
  // refining and reagents are the Gameplay data grids' (data-host.ts).
  crafting: ["fallbackReagent", "runeStone", "fittings", "units", "defaultUnits", "skills", "defaultSkill"],
};

export const contentDocFile = (repoRoot: string, name: ContentDocName): string => join(resolve(repoRoot, "content"), CONTENT_DOC_FILES[name]);

/** The document as written, or undefined when there is no file. */
export function readContentDoc(repoRoot: string, name: ContentDocName): unknown {
  const file = contentDocFile(repoRoot, name);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw Object.assign(new Error(`${CONTENT_DOC_FILES[name]}: ${(e as Error).message}`), { status: 500 });
  }
}

/** Validate, then write; throws { status: 400, issues } and writes nothing when refused. */
export async function saveContentDoc(repoRoot: string, name: ContentDocName, content: unknown): Promise<void> {
  const keys = CONTENT_DOC_KEYS[name];
  let candidate = content;
  if (keys) {
    if (content === null || typeof content !== "object" || Array.isArray(content)) throw refuseInvalid(name, [{ file: `${name}.json`, path: "", message: "must be an object" }]);
    const owned = Object.fromEntries(keys.filter((k) => Object.hasOwn(content, k)).map((k) => [k, (content as Record<string, unknown>)[k]]));
    candidate = { ...((readContentDoc(repoRoot, name) as Record<string, unknown> | undefined) ?? {}), ...owned };
  }
  const issues = await CONTENT_DOC_CHECKS[name](repoRoot, candidate);
  if (issues.length > 0) throw refuseInvalid(name, issues);
  writeJsonAtomic(contentDocFile(repoRoot, name), candidate);
}

export async function handleContentDocsRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): Promise<RouteReply | null> {
  const prefix = "/api/editor/docs/";
  if (!pathname.startsWith(prefix)) return null;
  const name = pathname.slice(prefix.length);
  if (!isContentDoc(name)) return { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (method === "GET") {
      const content = readContentDoc(repoRoot, name);
      if (content === undefined) return { status: 404, body: { ok: false, error: `no content/${CONTENT_DOC_FILES[name]}` } };
      return { status: 200, body: { ok: true, content } };
    }
    if (method === "PUT") {
      await saveContentDoc(repoRoot, name, jsonBodyField(body, "content"));
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, body: { ok: false, error: "method not allowed" } };
  } catch (err) {
    return failureReply(err);
  }
}
