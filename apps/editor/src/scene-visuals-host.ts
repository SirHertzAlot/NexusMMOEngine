/**
 * The viewport's visual table, served to the browser (roadmap EB1).
 *
 *   GET /api/editor/scene/visuals → { ok: true, visuals: {id: NodeVisual}, art: boolean }
 *
 * The browser can read neither the content files nor the engine's own
 * tables, so the host reads both and hands over the finished sizes:
 * `CHARACTER_CAPSULE` and `SPECIES_NATURAL_SCALE` from the engine (the same
 * values `CreatureService` spawns a creature with), the creature roster and
 * the spawn table for what exists, `content/scale.json` for the world's
 * scale, and the art pack's manifest for a model URL per id. `art` says
 * whether the pack answered for anything, so the viewport can tell a
 * missing pack from a missing model.
 *
 * The rules live in `scene-visuals.ts`, which is pure; this file is only
 * the reading.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHARACTER_CAPSULE, SPECIES_NATURAL_SCALE } from "@mmo-engine/engine-core";
import { DEFAULT_SCALE, validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { resolveAssetUrl } from "./asset-resolve.js";
import { buildVisuals, type NodeVisual } from "./scene-visuals.js";

export interface SceneVisualsView {
  visuals: Record<string, NodeVisual>;
  /** True when the art pack resolved a model for at least one id. */
  art: boolean;
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const asRecord = (v: unknown): Record<string, never> =>
  (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}) as Record<string, never>;

/** `content/scale.json`, or the default document when it is missing or invalid. */
export function readScaleDoc(repoRoot: string): ScaleDoc {
  const raw = readJson(join(repoRoot, "content", "scale.json"));
  if (!raw || validateScale(raw).length > 0) return DEFAULT_SCALE;
  return raw as unknown as ScaleDoc;
}

/** The whole table for `repoRoot`. */
export function readSceneVisuals(repoRoot: string): SceneVisualsView {
  const creatures = asRecord(readJson(join(repoRoot, "content", "rules", "creatures.json"))?.creatures);
  const archetypes = asRecord(
    readJson(join(repoRoot, "packages", "scatter", "examples", "forest.spawn-table.json"))?.archetypes,
  );
  let art = false;
  const visuals = buildVisuals({
    creatures,
    naturalScale: SPECIES_NATURAL_SCALE,
    capsule: CHARACTER_CAPSULE,
    archetypes,
    scale: readScaleDoc(repoRoot),
    model: (id) => {
      const hit = resolveAssetUrl(repoRoot, id);
      if (!hit.ok || !hit.url) return null;
      art = true;
      return hit.url;
    },
  });
  return { visuals, art };
}

/** Handle one request; null when the path is not the visuals route. */
export function handleSceneVisualsRoute(
  repoRoot: string,
  method: string,
  pathname: string,
): { status: number; body: unknown } | null {
  if (pathname !== "/api/editor/scene/visuals") return null;
  if (method !== "GET") return { status: 405, body: { ok: false, error: "GET only" } };
  return { status: 200, body: { ok: true, ...readSceneVisuals(repoRoot) } };
}
