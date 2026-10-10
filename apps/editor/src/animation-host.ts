/**
 * The clip map's storage for the editor dev host (roadmap EA21).
 *
 * Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/animation/clips        -> { ok, map, saved }  the map (the shipped default when no file yet)
 *   PUT /api/editor/animation/clips        -> { map } -> validate, then write content/animation/clips.json
 *   GET /content/animation/clips.json      -> the file, for the play-mode game view (the client reads it there)
 *
 * - A save is checked with art's `checkClipMap`, the module the client loads
 *   the file with; errors refuse it (400 with every issue, nothing written),
 *   warnings (a clip the library lacks) do not.
 * - The path is fixed, never taken from the request. The mutating route
 *   demands a JSON content type.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLIP_MAP, checkClipMap, parseClipMap, type ClipMap, type ClipMapIssue } from "@mmo-engine/art";
import { refuseInvalid } from "./api.js";

const clipMapFile = (repoRoot: string): string => join(repoRoot, "content", "animation", "clips.json");

/** The saved map, or the shipped default when the file is missing; throws when the file is not a clip map. */
export function readClipMap(repoRoot: string): { map: ClipMap; saved: boolean } {
  const file = clipMapFile(repoRoot);
  if (!existsSync(file)) return { map: DEFAULT_CLIP_MAP, saved: false };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw Object.assign(new Error("content/animation/clips.json is not valid JSON"), { status: 500 });
  }
  return { map: parseClipMap(json), saved: true };
}

/** Write a map after checking it. Throws a 400 carrying every error (and nothing is written) when there are any. */
export function saveClipMap(repoRoot: string, map: unknown): ClipMap {
  const errors = checkClipMap(map).filter((i) => i.severity === "error");
  if (errors.length > 0) throw refuseInvalid("clip map", errors);
  const file = clipMapFile(repoRoot);
  mkdirSync(join(repoRoot, "content", "animation"), { recursive: true });
  // Written beside the file and moved over it, so a reader never sees half a file.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
  renameSync(tmp, file);
  return map as ClipMap;
}

export type { ClipMapIssue };

/** One reply for the animation routes, or null for any other path (the host carries on). */
export async function handleAnimationRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  contentType: string | undefined,
  readBody: () => Promise<string>,
): Promise<{ status: number; body: unknown } | null> {
  const api = pathname === "/api/editor/animation/clips";
  const served = pathname === "/content/animation/clips.json";
  if (!api && !served) return null;
  try {
    if (method === "GET") {
      const { map, saved } = readClipMap(repoRoot);
      return { status: 200, body: served ? map : { ok: true, map, saved } };
    }
    if (api && method === "PUT") {
      if (!contentType?.toLowerCase().startsWith("application/json")) return { status: 415, body: { ok: false, error: "send application/json" } };
      let body: { map?: unknown };
      try {
        body = JSON.parse((await readBody()) || "{}") as { map?: unknown };
      } catch {
        return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
      }
      saveClipMap(repoRoot, body.map);
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, body: { ok: false, error: "method not allowed" } };
  } catch (e) {
    const err = e as Error & { status?: number; issues?: unknown };
    return { status: err.status ?? 500, body: { ok: false, error: err.message, ...(err.issues ? { issues: err.issues } : {}) } };
  }
}
