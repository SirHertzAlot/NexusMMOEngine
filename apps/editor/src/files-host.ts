/**
 * Content-browser file operations for the documents the editor owns.
 * Loopback routes wired in host.ts:
 *
 *   GET    /api/editor/files/:kind                  → { names }
 *   POST   /api/editor/files/:kind/:name/rename     { to }
 *   POST   /api/editor/files/:kind/:name/duplicate  { to? }   (default "<name>-copy")
 *   DELETE /api/editor/files/:kind/:name
 *
 * Only whitelisted kinds (scene, playtest, build) in their own folder; a name
 * is a plain lowercase identifier and the resolved path is checked to sit
 * inside that folder, so no route can touch any other file. The renamed or
 * copied document is validated first (with the same validator its own save
 * uses) and carries its new name; an existing target is never overwritten; a
 * scene the game flow uses cannot be renamed or deleted. A refused request
 * writes nothing.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadProfile } from "@mmo-engine/build";
import { validateScene } from "@mmo-engine/scene";
import { isSceneName } from "./scenes-host.js";
import { writeJsonAtomic } from "./json-file.js";
import type { RouteReply } from "./api.js";

export type FileKind = "scene" | "playtest" | "build";

interface KindSpec {
  dir: string[];
  suffix: string;
  isName(name: string): boolean;
  /** Problems with `doc` as the file called `name` (empty = fine). */
  check(repoRoot: string, doc: unknown, name: string): string[] | Promise<string[]>;
}

const issueText = (i: { path?: string; message: string }): string => (i.path ? `${i.path}: ${i.message}` : i.message);
const named = (d: unknown, n: string): string[] => ((d as { name?: unknown } | null)?.name === n ? [] : [`name: must match the file name "${n}"`]);
const reason = (e: unknown): string[] => {
  const issues = (e as { issues?: Array<{ path?: unknown[]; message: string }> }).issues;
  return issues ? issues.map((i) => issueText({ path: i.path?.join("."), message: i.message })) : [e instanceof Error ? e.message : String(e)];
};

const SPECS: Record<FileKind, KindSpec> = {
  scene: {
    dir: ["content", "scenes"],
    suffix: ".scene.json",
    isName: isSceneName,
    check: (_r, d, n) => [...validateScene(d).map(issueText), ...named(d, n)],
  },
  playtest: {
    dir: ["content", "playtests"],
    suffix: ".json",
    isName: (n) => /^[a-z][a-z0-9-]{0,47}$/.test(n),
    check: async (_r, d, n) => {
      try {
        // Looked up at run time: the editor does not depend on the playtest package.
        const pkg = "@mmo-engine/playtest";
        const { loadScenario } = (await import(/* @vite-ignore */ pkg)) as { loadScenario: (json: unknown) => unknown };
        loadScenario(d);
        return named(d, n);
      } catch (e) {
        return reason(e);
      }
    },
  },
  build: {
    dir: ["content", "build", "profiles"],
    suffix: ".json",
    isName: (n) => /^[a-z][a-z0-9-]{0,39}$/.test(n) && n !== "default",
    check: (_r, d, n) => {
      try {
        loadProfile(d);
        return named(d, n);
      } catch (e) {
        return reason(e);
      }
    },
  },
};

export const FILE_KINDS = Object.keys(SPECS) as FileKind[];
const isKind = (k: string): k is FileKind => Object.prototype.hasOwnProperty.call(SPECS, k);

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const dirOf = (repoRoot: string, kind: FileKind): string => resolve(repoRoot, ...SPECS[kind].dir);

function pathOf(repoRoot: string, kind: FileKind, name: string): string {
  const spec = SPECS[kind];
  if (!spec.isName(name)) throw new Refused(400, `bad ${kind} name "${name}" (lowercase letters, digits and dashes)`);
  const dir = dirOf(repoRoot, kind);
  const abs = join(dir, `${name}${spec.suffix}`);
  if (!abs.startsWith(dir + sep)) throw new Refused(400, "path escapes the content folder");
  return abs;
}

export function listFiles(repoRoot: string, kind: FileKind): string[] {
  const dir = dirOf(repoRoot, kind);
  const spec = SPECS[kind];
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(spec.suffix) && spec.isName(f.slice(0, -spec.suffix.length)))
    .map((f) => f.slice(0, -spec.suffix.length))
    .sort();
}

/** What uses `name`, or [] (only scenes are referenced: by the game flow's nodes). */
function usedBy(repoRoot: string, kind: FileKind, name: string): string[] {
  if (kind !== "scene") return [];
  try {
    const flow = JSON.parse(readFileSync(join(repoRoot, "content", "flow", "game.flow.json"), "utf8")) as { nodes?: Record<string, { scene?: unknown }> };
    return Object.entries(flow.nodes ?? {})
      .filter(([, n]) => n.scene === name)
      .map(([id]) => `flow node "${id}"`);
  } catch {
    return [];
  }
}

function readDoc(file: string, label: string): unknown {
  if (!existsSync(file)) throw new Refused(404, `no ${label}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw new Refused(400, `${label} is not valid JSON: ${(e as Error).message}`);
  }
}

/** The document as the file called `to`: validated, with its name field set. */
async function asNamed(repoRoot: string, kind: FileKind, doc: unknown, to: string): Promise<unknown> {
  const out = typeof doc === "object" && doc !== null && !Array.isArray(doc) && "name" in doc ? { ...(doc as Record<string, unknown>), name: to } : doc;
  const problems = await SPECS[kind].check(repoRoot, out, to);
  if (problems.length > 0) throw new Refused(400, `${kind} "${to}" would be invalid: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
  return out;
}

export async function renameFile(repoRoot: string, kind: FileKind, from: string, to: string): Promise<void> {
  const src = pathOf(repoRoot, kind, from);
  const dst = pathOf(repoRoot, kind, to);
  if (from === to) throw new Refused(400, "the new name is the same");
  const uses = usedBy(repoRoot, kind, from);
  if (uses.length > 0) throw new Refused(409, `"${from}" is used by ${uses.join(", ")}; change those first`);
  const doc = await asNamed(repoRoot, kind, readDoc(src, `${kind} "${from}"`), to);
  if (existsSync(dst)) throw new Refused(409, `${kind} "${to}" already exists`);
  writeJsonAtomic(dst, doc);
  rmSync(src);
}

export async function duplicateFile(repoRoot: string, kind: FileKind, from: string, to?: string): Promise<string> {
  const src = pathOf(repoRoot, kind, from);
  let target = to;
  if (target === undefined) {
    target = `${from}-copy`;
    for (let i = 2; existsSync(pathOf(repoRoot, kind, target)); i++) target = `${from}-copy-${i}`;
  }
  const dst = pathOf(repoRoot, kind, target);
  const doc = await asNamed(repoRoot, kind, readDoc(src, `${kind} "${from}"`), target);
  if (existsSync(dst)) throw new Refused(409, `${kind} "${target}" already exists`);
  writeJsonAtomic(dst, doc);
  return target;
}

export function deleteFile(repoRoot: string, kind: FileKind, name: string): void {
  const file = pathOf(repoRoot, kind, name);
  if (!existsSync(file)) throw new Refused(404, `no ${kind} "${name}"`);
  const uses = usedBy(repoRoot, kind, name);
  if (uses.length > 0) throw new Refused(409, `"${name}" is used by ${uses.join(", ")}; change those first`);
  rmSync(file);
}

/** Handle one request; null when the path is not a files route. */
export async function handleFilesRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): Promise<RouteReply | null> {
  if (!pathname.startsWith("/api/editor/files/")) return null;
  const fail = (status: number, error: string): RouteReply => ({ status, body: { ok: false, error } });
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).slice(3).map(decodeURIComponent);
  } catch {
    return fail(400, "bad path");
  }
  const [kind, name, action] = parts;
  if (!kind || !isKind(kind)) return fail(404, `unknown kind "${kind ?? ""}" (${FILE_KINDS.join(", ")})`);
  try {
    if (parts.length === 1 && method === "GET") return { status: 200, body: { ok: true, names: listFiles(repoRoot, kind) } };
    let json: { to?: unknown } = {};
    if (body !== undefined && body !== "") {
      try {
        json = JSON.parse(body) as { to?: unknown };
      } catch {
        return fail(400, "request body is not valid JSON");
      }
    }
    if (parts.length === 2 && method === "DELETE") {
      deleteFile(repoRoot, kind, name);
      return { status: 200, body: { ok: true, name } };
    }
    if (parts.length === 3 && method === "POST" && action === "rename") {
      if (typeof json.to !== "string") return fail(400, 'need {"to": "<new name>"}');
      await renameFile(repoRoot, kind, name, json.to);
      return { status: 200, body: { ok: true, name: json.to } };
    }
    if (parts.length === 3 && method === "POST" && action === "duplicate") {
      if (json.to !== undefined && typeof json.to !== "string") return fail(400, '"to" is a name');
      return { status: 200, body: { ok: true, name: await duplicateFile(repoRoot, kind, name, json.to) } };
    }
    return fail(404, "not found");
  } catch (e) {
    if (e instanceof Refused) return fail(e.status, e.message);
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}
