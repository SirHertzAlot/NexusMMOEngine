/**
 * Rig overrides for the editor dev host: `<repo>/content/rigs.local.json`
 * (gitignored; its keys are licensed catalog model ids). Loopback routes
 * (wired in host.ts):
 *
 *   GET /api/editor/rigs → { ok, doc }      (the empty document when no file exists)
 *   PUT /api/editor/rigs → { doc }          validate with validateRigs, then write
 *
 * A refused save answers 400 with every issue and writes nothing. The path is
 * fixed, never taken from the request.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";
import { emptyRigs, validateRigs, type RigDoc } from "./rig-doc.js";

export const rigsFile = (repoRoot: string): string => resolve(repoRoot, "content", "rigs.local.json");

export function readRigs(repoRoot: string): RigDoc {
  const file = rigsFile(repoRoot);
  if (!existsSync(file)) return emptyRigs();
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RigDoc;
  } catch (e) {
    throw Object.assign(new Error(`rigs.local.json: ${(e as Error).message}`), { status: 500 });
  }
}

/** Validate `doc`, then write it. Throws { status: 400, issues } and writes nothing when invalid. */
export function saveRigs(repoRoot: string, doc: unknown): RigDoc {
  const issues = validateRigs(doc);
  if (issues.length > 0) throw refuseInvalid("rigs", issues);
  const file = rigsFile(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return doc as RigDoc;
}

export function handleRigRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): RouteReply | null {
  if (pathname !== "/api/editor/rigs" && !pathname.startsWith("/api/editor/rigs/")) return null;
  if (pathname !== "/api/editor/rigs") return { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (method === "GET") return { status: 200, body: { ok: true, doc: readRigs(repoRoot) } };
    if (method === "PUT") return { status: 200, body: { ok: true, doc: saveRigs(repoRoot, jsonBodyField(body, "doc")) } };
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return failureReply(err);
  }
}
