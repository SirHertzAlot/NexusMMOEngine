/**
 * VFX effect storage for the editor dev host (roadmap EA22). Effects live as
 * engine-agnostic JSON documents in `<repo>/content/vfx/effects/<id>.json`,
 * validated by the `VfxEffect` zod schema from `@mmo-engine/art`
 * (packages/art/src/vfx-schema.ts). The client converts them to three.quarks
 * via `vfxToQuarks()` — it never reads quarks-native JSON. Loopback routes
 * (wired in host.ts):
 *
 *   GET  /api/editor/vfx/effects              → { effects: string[] }
 *   GET  /api/editor/vfx/effects/:id          → { content }
 *   PUT  /api/editor/vfx/effects/:id          → { content } → validate, then write
 *
 * A save is validated with `parseVfxEffect()`; a refused save answers 400
 * with every issue and writes nothing. Ids are confined to `[a-z0-9-_]+`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseInvalid } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";

export interface VfxIssue {
  /** Where in the document, e.g. "emitters.0.rate". */
  path: string;
  message: string;
}

const ID = /^[a-z0-9][a-z0-9-_]*$/;

export const vfxDir = (repoRoot: string): string => join(resolve(repoRoot, "content", "vfx"), "effects");
export const vfxFile = (repoRoot: string, id: string): string => join(vfxDir(repoRoot), `${id}.json`);

interface VfxEffectSchema {
  safeParse(json: unknown): { success: true } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

const schemas = new Map<string, Promise<VfxEffectSchema>>();

/** The `VfxEffect` schema from @mmo-engine/art's build. */
function loadSchema(repoRoot: string): Promise<VfxEffectSchema> {
  let p = schemas.get(repoRoot);
  if (!p) {
    const file = join(repoRoot, "packages", "art", "dist", "src", "vfx-schema.js");
    p = import(pathToFileURL(file).href).then(
      (m: { VfxEffect: VfxEffectSchema }) => m.VfxEffect,
      (e: unknown) => {
        schemas.delete(repoRoot);
        throw Object.assign(new Error(`the VFX schema isn't built (npm run build -w @mmo-engine/art): ${(e as Error).message}`), { status: 500 });
      },
    );
    schemas.set(repoRoot, p);
  }
  return p;
}

/** Every problem with `content` as a VfxEffect (empty: valid). */
export async function checkVfx(repoRoot: string, content: unknown): Promise<VfxIssue[]> {
  const result = (await loadSchema(repoRoot)).safeParse(content);
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export interface VfxRouteReply {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): VfxRouteReply => ({ status, body });

export async function handleVfxRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  readBody: () => Promise<unknown>,
): Promise<VfxRouteReply | null> {
  const base = "/api/editor/vfx";
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);

  if (rest === "/effects" && method === "GET") {
    let effects: string[] = [];
    try {
      effects = readdirSync(vfxDir(repoRoot))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .filter((id) => ID.test(id))
        .sort();
    } catch {
      effects = [];
    }
    return json(200, { effects });
  }

  const m = rest.match(/^\/effects\/([a-z0-9][a-z0-9-_]*)$/);
  if (!m) return null;
  const id = m[1];

  if (method === "GET") {
    try {
      const content = JSON.parse(readFileSync(vfxFile(repoRoot, id), "utf8"));
      return json(200, { content });
    } catch {
      return json(404, { error: `no such effect: ${id}` });
    }
  }

  if (method === "PUT") {
    const raw = await readBody();
    const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as { content?: unknown };
    const issues = await checkVfx(repoRoot, body?.content);
    if (issues.length > 0) throw refuseInvalid("vfx", issues);
    writeJsonAtomic(vfxFile(repoRoot, id), body.content);
    return json(200, { ok: true });
  }

  return json(405, { error: "method not allowed" });
}
