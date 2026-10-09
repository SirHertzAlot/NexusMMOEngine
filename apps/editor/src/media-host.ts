/**
 * Media content storage for the editor dev host (roadmap EA21, EA22, EA24):
 * the six documents the Animation, VFX and Audio workspaces edit, which the
 * game reads (the server for combat moves, the client for the rest).
 *
 *   GET /api/editor/media            → { content: GameContent }   (what the game view applies)
 *   GET /api/editor/media/<name>     → { content }
 *   PUT /api/editor/media/<name>     → { content } → validate, then write
 *
 * `<name>` is one of combat, animation, vfx, tiers, materials, audio; each
 * maps to one fixed file under `<repo>/content` (see MEDIA_DOCS), so there
 * is no path to confine. A save is validated with the document's checks and
 * against the other documents (an audio event a move or a surface names must
 * exist); a refused save answers 400 with every issue and writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MEDIA_DOCS, MEDIA_DOC_NAMES, crossCheck, type GameContent, type MediaDocName, type MediaIssue } from "@mmo-engine/art";

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

const key = (i: MediaIssue): string => `${i.path}|${i.message}`;

export function saveMedia(repoRoot: string, name: MediaDocName, content: unknown): void {
  const issues = MEDIA_DOCS[name].validate(content);
  if (issues.length === 0) {
    // References between documents: refuse a save that adds a dangling one (old ones don't block).
    const disk = readMedia(repoRoot);
    const before = new Set(crossCheck(disk).map(key));
    const added = crossCheck({ ...disk, [name]: content } as GameContent).filter((i) => !before.has(key(i)));
    issues.push(...added);
  }
  if (issues.length > 0) {
    throw Object.assign(new Error(`invalid ${name}: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
  }
  const file = fileOf(repoRoot, name);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function handleMediaRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
): { status: number; body: unknown } | null {
  if (pathname !== "/api/editor/media" && !pathname.startsWith("/api/editor/media/")) return null;
  try {
    if (pathname === "/api/editor/media") {
      if (method !== "GET") return { status: 404, body: { ok: false, error: "not found" } };
      return { status: 200, body: { ok: true, content: readMedia(repoRoot) } };
    }
    const name = pathname.slice("/api/editor/media/".length) as MediaDocName;
    if (!(MEDIA_DOC_NAMES as readonly string[]).includes(name)) return { status: 404, body: { ok: false, error: "not found" } };
    if (method === "GET") {
      const file = fileOf(repoRoot, name);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: `no ${MEDIA_DOCS[name].file}` } };
      return { status: 200, body: { ok: true, content: JSON.parse(readFileSync(file, "utf8")) as unknown } };
    }
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
      saveMedia(repoRoot, name, (parsed as { content: unknown }).content);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    const e = err as { status?: number; issues?: unknown };
    return {
      status: e.status ?? 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
    };
  }
}
