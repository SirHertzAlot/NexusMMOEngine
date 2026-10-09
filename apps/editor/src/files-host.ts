/**
 * Content-browser file operations for the documents the editor owns
 * (roadmap: editor menus live). Loopback routes wired in host.ts:
 *
 *   GET    /api/editor/files/:kind                  → { names }
 *   POST   /api/editor/files/:kind/:name/rename     { to }
 *   POST   /api/editor/files/:kind/:name/duplicate  { to? }   (default "<name>-copy")
 *   DELETE /api/editor/files/:kind/:name
 *
 * Only whitelisted kinds (scene, prefab, playtest, build) in their own
 * folder; a name is a plain lowercase identifier and the resolved path is
 * checked to sit inside that folder, so no route can touch any other file.
 * The renamed or copied document is validated first and carries its new
 * name; an existing target is never overwritten; a scene the game flow
 * uses cannot be renamed or deleted. A refused request writes nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { validateScene } from "@mmo-engine/scene";
import { validatePlaytest } from "./playtest-model.js";
import { validateProfile } from "./release-model.js";

export type FileKind = "scene" | "prefab" | "playtest" | "build";

interface KindSpec {
  dir: string[];
  suffix: string;
  name: RegExp;
  /** Problems with `doc` as the file called `name` (empty = fine). */
  check(doc: unknown, name: string): string[];
}

const SPECS: Record<FileKind, KindSpec> = {
  scene: {
    dir: ["content", "scenes"],
    suffix: ".scene.json",
    name: /^[a-z0-9][a-z0-9-]*$/,
    check: (d, n) => [
      ...validateScene(d).map((i) => `${i.path}: ${i.message}`),
      ...((d as { name?: unknown } | null)?.name === n ? [] : [`name: must match the file name "${n}"`]),
    ],
  },
  prefab: {
    dir: ["content", "prefabs"],
    suffix: ".prefab.json",
    name: /^[a-z0-9][a-z0-9-]*$/,
    check: (d) => (typeof d === "object" && d !== null && !Array.isArray(d) ? [] : ["a prefab is a JSON object"]),
  },
  playtest: {
    dir: ["content", "playtests"],
    suffix: ".playtest.json",
    name: /^[a-z][a-z0-9-]{0,47}$/,
    check: (d, n) => validatePlaytest(d, n).map((i) => `${i.path}: ${i.message}`),
  },
  build: {
    dir: ["content", "build"],
    suffix: ".json",
    name: /^[a-z][a-z0-9-]{0,39}$/,
    check: (d, n) => validateProfile(d, n),
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

function dirOf(repoRoot: string, kind: FileKind): string {
  return resolve(repoRoot, ...SPECS[kind].dir);
}

function pathOf(repoRoot: string, kind: FileKind, name: string): string {
  const spec = SPECS[kind];
  if (!spec.name.test(name)) throw new Refused(400, `bad ${kind} name "${name}" (lowercase letters, digits and dashes)`);
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
    .filter((f) => f.endsWith(spec.suffix) && spec.name.test(f.slice(0, -spec.suffix.length)))
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

function writeNew(file: string, doc: unknown): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** The document as the file called `to`: validated, with its name field set. */
function asNamed(kind: FileKind, doc: unknown, to: string): unknown {
  const named =
    typeof doc === "object" && doc !== null && !Array.isArray(doc) && "name" in doc ? { ...(doc as Record<string, unknown>), name: to } : doc;
  const problems = SPECS[kind].check(named, to);
  if (problems.length > 0) throw new Refused(400, `${kind} "${to}" would be invalid: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
  return named;
}

export function renameFile(repoRoot: string, kind: FileKind, from: string, to: string): void {
  const src = pathOf(repoRoot, kind, from);
  const dst = pathOf(repoRoot, kind, to);
  if (from === to) throw new Refused(400, "the new name is the same");
  const uses = usedBy(repoRoot, kind, from);
  if (uses.length > 0) throw new Refused(409, `"${from}" is used by ${uses.join(", ")}; change those first`);
  const doc = asNamed(kind, readDoc(src, `${kind} "${from}"`), to);
  if (existsSync(dst)) throw new Refused(409, `${kind} "${to}" already exists`);
  writeNew(dst, doc);
  rmSync(src);
}

export function duplicateFile(repoRoot: string, kind: FileKind, from: string, to?: string): string {
  const src = pathOf(repoRoot, kind, from);
  let target = to;
  if (target === undefined) {
    target = `${from}-copy`;
    for (let i = 2; existsSync(pathOf(repoRoot, kind, target)); i++) target = `${from}-copy-${i}`;
  }
  const dst = pathOf(repoRoot, kind, target);
  const doc = asNamed(kind, readDoc(src, `${kind} "${from}"`), target);
  if (existsSync(dst)) throw new Refused(409, `${kind} "${target}" already exists`);
  writeNew(dst, doc);
  return target;
}

export function deleteFile(repoRoot: string, kind: FileKind, name: string): void {
  const file = pathOf(repoRoot, kind, name);
  if (!existsSync(file)) throw new Refused(404, `no ${kind} "${name}"`);
  const uses = usedBy(repoRoot, kind, name);
  if (uses.length > 0) throw new Refused(409, `"${name}" is used by ${uses.join(", ")}; change those first`);
  rmSync(file);
}

export interface FilesRouteResult {
  status: number;
  body: unknown;
}

/** Handle one request; null when the path is not a files route. */
export function handleFilesRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): FilesRouteResult | null {
  if (!pathname.startsWith("/api/editor/files/")) return null;
  const fail = (status: number, error: string): FilesRouteResult => ({ status, body: { ok: false, error } });
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
      renameFile(repoRoot, kind, name, json.to);
      return { status: 200, body: { ok: true, name: json.to } };
    }
    if (parts.length === 3 && method === "POST" && action === "duplicate") {
      if (json.to !== undefined && typeof json.to !== "string") return fail(400, '"to" is a name');
      return { status: 200, body: { ok: true, name: duplicateFile(repoRoot, kind, name, json.to) } };
    }
    return fail(404, "not found");
  } catch (e) {
    if (e instanceof Refused) return fail(e.status, e.message);
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}
