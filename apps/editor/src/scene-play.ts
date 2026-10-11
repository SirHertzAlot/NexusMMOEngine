/**
 * Host side of scene viewport editing and play (roadmap EA5, EA6).
 *
 *   GET /api/editor/content/placeables → { species, props, pcg }
 *     What the viewport's content browser can drop into a scene: creature
 *     species (content/rules/creatures.json), props (the spawn table the
 *     server's admin `spawn` uses) and PICG assets (content/pcg/index.json).
 *     All are read-only listings; a missing source lists as empty.
 *
 *   playSceneEnv(): the environment that makes the owned play server run
 *   a scene (MMO_SCENE). The open document may be unsaved: it is
 *   validated and written under the play data dir, never content/scenes,
 *   so playing leaves the document and the repo untouched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateScene } from "@mmo-engine/scene";
import { isSceneName, resolveScenePath } from "./scenes-host.js";
import { refuseInvalid } from "./api.js";

export interface Placeable {
  id: string;
  label: string;
}
export interface Placeables {
  species: Placeable[];
  props: Placeable[];
  pcg: Placeable[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const keysOf = (v: unknown): string[] =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v as object).sort() : [];

export function listPlaceables(repoRoot: string): Placeables {
  const creatures = (readJson(join(repoRoot, "content", "rules", "creatures.json"))?.creatures ?? {}) as Record<string, { name?: unknown }>;
  const species = keysOf(creatures).map((id) => ({ id, label: typeof creatures[id]?.name === "string" ? (creatures[id].name as string) : id }));
  const props = keysOf(readJson(join(repoRoot, "packages", "scatter", "examples", "forest.spawn-table.json"))?.archetypes).map((id) => ({ id, label: id }));
  const assets = readJson(join(repoRoot, "content", "pcg", "index.json"))?.assets;
  const pcg = (Array.isArray(assets) ? assets : []).flatMap((a: unknown) => {
    const o = a as { id?: unknown; displayName?: unknown };
    return typeof o?.id === "string" ? [{ id: o.id, label: typeof o.displayName === "string" ? o.displayName : o.id }] : [];
  });
  return { species, props, pcg };
}

/** Handle one request; null when the path is not a content route. */
export function handleContentRoute(repoRoot: string, method: string, pathname: string): { status: number; body: unknown } | null {
  if (pathname !== "/api/editor/content/placeables") return null;
  if (method !== "GET") return { status: 404, body: { ok: false, error: "not found" } };
  return { status: 200, body: { ok: true, ...listPlaceables(repoRoot) } };
}

export interface PlaySceneRequest {
  name: string;
  /** The open document, possibly unsaved; absent plays the saved file. */
  content?: unknown;
}

const refuse = (status: number, message: string, extra: object = {}): Error => Object.assign(new Error(message), { status, ...extra });

/** Environment for the play server so it runs `req` (empty when no scene is asked for). */
export function playSceneEnv(
  repoRoot: string,
  dataDir: string,
  req: PlaySceneRequest | undefined,
): { MMO_SCENE?: string; MMO_SCENES?: string } {
  if (!req) return {};
  if (typeof req.name !== "string" || !isSceneName(req.name)) throw refuse(400, `bad scene name "${String(req.name)}"`);
  if (req.content === undefined) {
    if (!existsSync(resolveScenePath(repoRoot, req.name))) throw refuse(404, `no scene "${req.name}"`);
    return { MMO_SCENE: req.name };
  }
  const issues = validateScene(req.content);
  const doc = req.content as { name?: unknown; kind?: unknown };
  if (issues.length === 0 && doc.name !== req.name) issues.push({ path: "name", message: `must match the scene name "${req.name}"` });
  if (issues.length === 0 && doc.kind === "frontend") issues.push({ path: "kind", message: "a frontend scene is client-only; the server runs world, instance or arena scenes" });
  if (issues.length > 0) throw refuseInvalid("scene", issues);
  const dir = join(dataDir, "play-scenes");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${req.name}.scene.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(req.content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return { MMO_SCENE: req.name, MMO_SCENES: dir };
}
