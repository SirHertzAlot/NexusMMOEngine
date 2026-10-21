/**
 * Scale document for the editor dev host: `<repo>/content/scale.json`, the
 * global size dial (packages/scene scale.ts). Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/scale → { ok, doc }      (the default when no file exists)
 *   PUT /api/editor/scale → { doc }          validate with validateScale, then write
 *
 * A refused save answers 400 with every issue and writes nothing. The path is
 * fixed, never taken from the request.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_SCALE, validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";

export const scaleFile = (repoRoot: string): string => resolve(repoRoot, "content", "scale.json");

export function readScale(repoRoot: string): ScaleDoc {
  const file = scaleFile(repoRoot);
  if (!existsSync(file)) return DEFAULT_SCALE;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ScaleDoc;
  } catch (e) {
    throw Object.assign(new Error(`scale.json: ${(e as Error).message}`), { status: 500 });
  }
}

/** Validate `doc`, then write it. Throws { status: 400, issues } and writes nothing when invalid. */
export function saveScale(repoRoot: string, doc: unknown): ScaleDoc {
  const issues = validateScale(doc);
  if (issues.length > 0) throw refuseInvalid("scale", issues);
  const file = scaleFile(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return doc as ScaleDoc;
}

export function handleScaleRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): RouteReply | null {
  if (pathname !== "/api/editor/scale" && !pathname.startsWith("/api/editor/scale/")) return null;
  if (pathname !== "/api/editor/scale") return { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (method === "GET") return { status: 200, body: { ok: true, doc: readScale(repoRoot) } };
    if (method === "PUT") return { status: 200, body: { ok: true, doc: saveScale(repoRoot, jsonBodyField(body, "doc")) } };
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return failureReply(err);
  }
}
