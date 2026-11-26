/**
 * The Blender live-link on the editor dev host (docs/BLENDER-LINK.md,
 * slice EU10). Loopback routes, wired in host.ts:
 *
 *   GET  /api/editor/blender                 → { ok, dir, addon, models }
 *   POST /api/editor/blender/push?name=hero[&from=hero.blend]
 *                                            → the .glb body, streamed to
 *                                              <repo>/assets/live/hero.glb
 *
 * The add-on in Blender exports the selection and POSTs it here. Three
 * things make that safe enough to leave running while someone models:
 *
 *   - the name is checked against a whitelist before anything is
 *     opened, so no push can name a path (`blender-link.ts`);
 *   - the body is streamed to a temporary file with a hard byte cap and
 *     renamed into place only once it is whole, so a cancelled export
 *     cannot leave a half-written model where the editor will load it;
 *   - the first twelve bytes must be a glTF binary header, so a push
 *     that is not a model is refused before it costs a rename.
 *
 * `assets/` is gitignored and `vcs-host.ts` refuses every path under
 * it, so nothing that arrives here can be committed by accident. That
 * is also why this is the only folder the live link writes to.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LIVE_DIR,
  MAX_BYTES,
  liveModelFile,
  recordPush,
  refuseModel,
  type LiveIndex,
  type LiveModel,
} from "./blender-link.js";
import { failureReply, type RouteReply } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";

/** Where the add-on lives in this repository, for the panel to point at. */
export const ADDON_FILE = "scripts/blender/mmo_live_link.py";

const liveDir = (repoRoot: string): string => join(resolve(repoRoot), ...LIVE_DIR.split("/"));
const indexFile = (repoRoot: string): string => join(liveDir(repoRoot), "index.json");

/** The live-link index, or an empty one when nothing has been pushed yet. */
export function readIndex(repoRoot: string): LiveIndex {
  const file = indexFile(repoRoot);
  if (!existsSync(file)) return { models: [] };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveIndex>;
    const models = Array.isArray(doc.models) ? doc.models : [];
    // A model whose file was deleted by hand is not reported as present.
    return { models: models.filter((m) => existsSync(join(resolve(repoRoot), ...liveModelFile(m.name).split("/")))) };
  } catch {
    return { models: [] };
  }
}

/** glTF binary: magic `glTF`, then version and total length, little-endian. */
export function isGlb(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (magic !== "glTF") return false;
  const version = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24);
  return version === 2;
}

class Refused extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Stream `body` into the live folder as `<name>.glb`. Returns what the
 * index now holds for it. Nothing is written outside the temporary file
 * until the body is whole and has been recognised as a model.
 */
export async function receivePush(
  repoRoot: string,
  name: string,
  body: AsyncIterable<Uint8Array>,
  from: string | undefined,
  now = Date.now(),
): Promise<LiveModel> {
  const nameRefusal = refuseModel(name, 1);
  if (nameRefusal !== null) throw new Refused(nameRefusal);

  const dir = liveDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.part`);
  const out = createWriteStream(tmp);
  let bytes = 0;
  let head = new Uint8Array(0);

  const stop = (reason: Refused): never => {
    out.destroy();
    rmSync(tmp, { force: true });
    throw reason;
  };

  try {
    for await (const chunk of body) {
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (head.length < 12) {
        const merged = new Uint8Array(head.length + buf.length);
        merged.set(head);
        merged.set(buf, head.length);
        head = merged.slice(0, 12);
        if (head.length >= 12 && !isGlb(head)) {
          stop(new Refused(`"${name}": not a glTF binary (.glb) export`));
        }
      }
      bytes += buf.length;
      if (bytes > MAX_BYTES) {
        stop(new Refused(refuseModel(name, bytes) ?? `"${name}": too large`, 413));
      }
      if (!out.write(buf)) await new Promise<void>((done) => out.once("drain", done));
    }
  } catch (err) {
    if (err instanceof Refused) throw err;
    out.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }

  await new Promise<void>((done, fail) => out.end((e?: Error | null) => (e ? fail(e) : done())));

  const sizeRefusal = refuseModel(name, bytes);
  if (sizeRefusal !== null) {
    rmSync(tmp, { force: true });
    throw new Refused(sizeRefusal, bytes > MAX_BYTES ? 413 : 400);
  }
  if (!isGlb(head)) {
    rmSync(tmp, { force: true });
    throw new Refused(`"${name}": not a glTF binary (.glb) export`);
  }

  const file = join(resolve(repoRoot), ...liveModelFile(name).split("/"));
  renameSync(tmp, file);
  const index = recordPush(readIndex(repoRoot), { name, bytes: statSync(file).size, at: now, ...(from ? { from } : {}) });
  writeJsonAtomic(indexFile(repoRoot), index);
  const model = index.models[0];
  return model;
}

export async function handleBlenderRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: AsyncIterable<Uint8Array> | undefined,
): Promise<RouteReply | null> {
  if (pathname !== "/api/editor/blender" && !pathname.startsWith("/api/editor/blender/")) return null;
  try {
    if (method === "GET" && pathname === "/api/editor/blender") {
      return { status: 200, body: { ok: true, dir: LIVE_DIR, addon: ADDON_FILE, ...readIndex(repoRoot) } };
    }
    if (method === "POST" && pathname === "/api/editor/blender/push") {
      if (body === undefined) return { status: 400, body: { ok: false, error: "no body" } };
      const name = (query.get("name") ?? "").trim();
      const from = query.get("from")?.trim() || undefined;
      const model = await receivePush(repoRoot, name, body, from);
      return { status: 200, body: { ok: true, model } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { ok: false, error: err.message } };
    return failureReply(err);
  }
}
