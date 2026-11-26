/**
 * Browser-safe adapter for the viewport's visual table
 * (GET /api/editor/scene/visuals, see scene-visuals-host.ts).
 */

import { requestJson } from "./api.js";
import type { NodeVisual } from "./scene-visuals.js";

export type { NodeVisual };

export interface SceneVisuals {
  visuals: Record<string, NodeVisual>;
  art: boolean;
}

export async function fetchSceneVisuals(base = ""): Promise<SceneVisuals> {
  const body = await requestJson<Partial<SceneVisuals>>(`${base}/api/editor/scene/visuals`, {
    fail: "visual table failed",
  });
  return { visuals: body.visuals ?? {}, art: body.art === true };
}
