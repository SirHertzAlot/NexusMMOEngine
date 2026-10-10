/**
 * Audio events storage for the editor dev host (roadmap EA24). One fixed
 * document, `<repo>/content/audio/events.json` (the buses' mixer settings
 * and the events), so there is no name to confine. Loopback routes (wired
 * in host.ts):
 *
 *   GET  /api/editor/audio       → { content }
 *   POST /api/editor/audio/save  → { content } → validate, then write
 *
 * A save is validated with the server's own `AudioBank` schema (engine-core's
 * build, the same one the game reads with); a refused save answers 400 with
 * every issue and writes nothing.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseInvalid } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";

export interface AudioIssue {
  /** Where in the document, e.g. "events.2.name". */
  path: string;
  message: string;
}

interface AudioSchema {
  safeParse(json: unknown): { success: true } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

export const audioFile = (repoRoot: string): string => join(resolve(repoRoot, "content", "audio"), "events.json");

const schemas = new Map<string, Promise<AudioSchema>>();

/** The server's `AudioBank` schema, from engine-core's build. */
function loadSchema(repoRoot: string): Promise<AudioSchema> {
  let p = schemas.get(repoRoot);
  if (!p) {
    const file = join(repoRoot, "packages", "engine-core", "dist", "src", "audio.js");
    p = import(pathToFileURL(file).href).then(
      (m: { AudioBank: AudioSchema }) => m.AudioBank,
      (e: unknown) => {
        schemas.delete(repoRoot);
        throw Object.assign(new Error(`the server's audio schema isn't built (npm run build -w @mmo-engine/engine-core): ${(e as Error).message}`), { status: 500 });
      },
    );
    schemas.set(repoRoot, p);
  }
  return p;
}

/** Every problem with `content` as an audio bank (empty: valid). */
export async function checkAudio(repoRoot: string, content: unknown): Promise<AudioIssue[]> {
  const result = (await loadSchema(repoRoot)).safeParse(content);
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export async function saveAudio(repoRoot: string, content: unknown): Promise<void> {
  const issues = await checkAudio(repoRoot, content);
  if (issues.length > 0) throw refuseInvalid("audio", issues);
  writeJsonAtomic(audioFile(repoRoot), content);
}

export async function handleAudioRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  readBody: () => Promise<string>,
): Promise<{ status: number; body: unknown } | null> {
  if (pathname !== "/api/editor/audio" && !pathname.startsWith("/api/editor/audio/")) return null;
  try {
    if (method === "GET" && pathname === "/api/editor/audio") {
      return { status: 200, body: { ok: true, content: JSON.parse(readFileSync(audioFile(repoRoot), "utf8")) as unknown } };
    }
    if (method === "POST" && pathname === "/api/editor/audio/save") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody()) as unknown;
      } catch {
        return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
      }
      if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) {
        return { status: 400, body: { ok: false, error: 'need a JSON body shaped like {"content": …}' } };
      }
      await saveAudio(repoRoot, (parsed as { content: unknown }).content);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    const e = err as { status?: number; issues?: AudioIssue[] };
    // callEnvelope shows only `error`, so a refusal names its problems there.
    const detail = e.issues ? `: ${e.issues.map((i) => `${i.path} ${i.message}`).join("; ")}` : "";
    return {
      status: e.status ?? 500,
      body: { ok: false, error: `${err instanceof Error ? err.message : String(err)}${detail}`, ...(e.issues ? { issues: e.issues } : {}) },
    };
  }
}
