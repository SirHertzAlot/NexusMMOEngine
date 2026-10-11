/**
 * Animation-side content storage for the editor dev host (roadmap EA21,
 * EA22): the combat moves, the locomotion graph (a v3 animation manifest)
 * and the toon/surface materials, which the game reads (the server for the
 * moves, the client for the rest). Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/media          -> { ok, content }  every document on disk (what the game view applies)
 *   GET /api/editor/media/<name>   -> { ok, content }
 *   PUT /api/editor/media/<name>   -> { content } -> validate, then write
 *
 * `<name>` is one of combat, animation, materials; each maps to one fixed
 * file under `<repo>/content` (art's MEDIA_DOCS), so there is no path to
 * confine. A save is validated with the document's checks and against
 * content/audio/events.json (an audio event a move or a surface names must
 * exist; old dangling names do not block an unrelated edit). A refused save
 * answers 400 with every issue and writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEDIA_DOCS, MEDIA_DOC_NAMES, missingAudioEvents, type GameContent, type MediaDocName, type MediaIssue } from "@mmo-engine/art";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";

const fileOf = (repoRoot: string, name: MediaDocName): string => join(resolve(repoRoot, "content"), MEDIA_DOCS[name].file);

/** Every media document on disk (a missing file is absent). */
export function readMedia(repoRoot: string): GameContent {
  const out: Record<string, unknown> = {};
  for (const name of MEDIA_DOC_NAMES) {
    const file = fileOf(repoRoot, name);
    if (existsSync(file)) out[name] = JSON.parse(readFileSync(file, "utf8")) as unknown;
  }
  return out as GameContent;
}

/** The audio event names in content/audio/events.json (empty when the file is missing or unreadable). */
function audioEventNames(repoRoot: string): Set<string> {
  try {
    const doc = JSON.parse(readFileSync(join(resolve(repoRoot, "content"), "audio", "events.json"), "utf8")) as { events?: Array<{ name?: unknown }> };
    return new Set((doc.events ?? []).map((e) => e.name).filter((n): n is string => typeof n === "string"));
  } catch {
    return new Set();
  }
}

const key = (i: MediaIssue): string => `${i.path}|${i.message}`;

/** Validate and write one document; throws a 400 carrying every issue (and writes nothing) when it is refused. */
export function saveMedia(repoRoot: string, name: MediaDocName, content: unknown): void {
  const issues = MEDIA_DOCS[name].validate(content);
  if (issues.length === 0) {
    const events = audioEventNames(repoRoot);
    if (events.size > 0) {
      const disk = readMedia(repoRoot);
      const before = new Set(missingAudioEvents(disk, events).map(key));
      issues.push(...missingAudioEvents({ ...disk, [name]: content } as GameContent, events).filter((i) => !before.has(key(i))));
    }
  }
  if (issues.length > 0) throw refuseInvalid(name, issues);
  writeJsonAtomic(fileOf(repoRoot, name), content);
}

export async function handleMediaRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  contentType: string | undefined,
  readBody: () => Promise<string>,
): Promise<RouteReply | null> {
  if (pathname !== "/api/editor/media" && !pathname.startsWith("/api/editor/media/")) return null;
  try {
    if (pathname === "/api/editor/media") {
      if (method !== "GET") return { status: 405, body: { ok: false, error: "method not allowed" } };
      return { status: 200, body: { ok: true, content: readMedia(repoRoot) } };
    }
    const name = pathname.slice("/api/editor/media/".length) as MediaDocName;
    if (!(MEDIA_DOC_NAMES as readonly string[]).includes(name)) return { status: 404, body: { ok: false, error: "not found" } };
    if (method === "GET") {
      const file = fileOf(repoRoot, name);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: `no content/${MEDIA_DOCS[name].file}` } };
      return { status: 200, body: { ok: true, content: JSON.parse(readFileSync(file, "utf8")) as unknown } };
    }
    if (method === "PUT") {
      if (!contentType?.toLowerCase().startsWith("application/json")) return { status: 415, body: { ok: false, error: "send application/json" } };
      saveMedia(repoRoot, name, jsonBodyField(await readBody(), "content"));
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, body: { ok: false, error: "method not allowed" } };
  } catch (err) {
    return failureReply(err);
  }
}
