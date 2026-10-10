/**
 * Scene file storage for the editor dev host (roadmap EA4).
 *
 * Loopback routes (wired in host.ts), same posture as rules-host.ts:
 *
 *   GET /api/editor/scenes        → { scenes: ["arena", …] }
 *   GET /api/editor/scenes/:name  → { name, content }
 *   PUT /api/editor/scenes/:name  → { content } → validate, then write
 *
 * - A name is lowercase letters, digits and dashes, never a path, and the
 *   resolved file is checked to sit inside <repo>/content/scenes.
 * - A save is validated with `validateScene` and must carry the same name
 *   as its file; it is written (temp file, then rename) only with zero
 *   problems. A refused save answers 400 with every issue and writes nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { validateScene, type SceneIssue } from "@mmo-engine/scene";
import { refuseInvalid } from "./api.js";

const SUFFIX = ".scene.json";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const isSceneName = (name: string): boolean => NAME_RE.test(name);

export function scenesDir(repoRoot: string): string {
  return resolve(repoRoot, "content", "scenes");
}

/** Absolute path of a scene file; { status: 404 } for anything that is not a plain name. */
export function resolveScenePath(repoRoot: string, name: string): string {
  if (!isSceneName(name)) {
    throw Object.assign(new Error(`bad scene name "${name}" (lowercase letters, digits and dashes)`), { status: 404 });
  }
  const dir = scenesDir(repoRoot);
  const abs = join(dir, `${name}${SUFFIX}`);
  if (!abs.startsWith(dir + sep)) throw Object.assign(new Error("path escapes scenes root"), { status: 500 });
  return abs;
}

export function listScenes(repoRoot: string): string[] {
  const dir = scenesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX) && isSceneName(f.slice(0, -SUFFIX.length)))
    .map((f) => f.slice(0, -SUFFIX.length))
    .sort();
}

export function readScene(repoRoot: string, name: string): unknown {
  const file = resolveScenePath(repoRoot, name);
  if (!existsSync(file)) throw Object.assign(new Error(`no scene "${name}"`), { status: 404 });
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    throw Object.assign(new Error(`${name}${SUFFIX}: not valid JSON: ${(e as Error).message}`), { status: 500 });
  }
}

export function saveScene(repoRoot: string, name: string, content: unknown): void {
  const file = resolveScenePath(repoRoot, name);
  const issues: SceneIssue[] = validateScene(content);
  if (issues.length === 0 && (content as { name: string }).name !== name) {
    issues.push({ path: "name", message: `must match the file name "${name}"` });
  }
  if (issues.length > 0) {
    throw refuseInvalid("scene", issues);
  }
  mkdirSync(scenesDir(repoRoot), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export interface SceneRouteResult {
  status: number;
  body: unknown;
}

/** Handle one request; null when the path is not a scenes route. `body` is the raw PUT body. */
export function handleScenesRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
): SceneRouteResult | null {
  if (pathname !== "/api/editor/scenes" && !pathname.startsWith("/api/editor/scenes/")) return null;
  const fail = (err: unknown): SceneRouteResult => {
    const e = err as { status?: number; issues?: unknown };
    return {
      status: e.status ?? 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
    };
  };
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (parts.length === 3 && method === "GET") return { status: 200, body: { ok: true, scenes: listScenes(repoRoot) } };
    if (parts.length !== 4) return { status: 404, body: { ok: false, error: "not found" } };
    let name: string;
    try {
      name = decodeURIComponent(parts[3]);
    } catch {
      return { status: 400, body: { ok: false, error: "bad scene name" } };
    }
    if (method === "GET") return { status: 200, body: { ok: true, name, content: readScene(repoRoot, name) } };
    if (method === "PUT") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "") as unknown;
      } catch {
        return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
      }
      if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) {
        return { status: 400, body: { ok: false, error: 'need a JSON body shaped like {"content": …}' } };
      }
      saveScene(repoRoot, name, (parsed as { content: unknown }).content);
      return { status: 200, body: { ok: true, name } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return fail(err);
  }
}
