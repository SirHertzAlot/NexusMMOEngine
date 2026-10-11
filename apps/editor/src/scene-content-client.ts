/**
 * Browser-safe adapter for the viewport's content browser: what the host
 * lists as placeable (see scene-play.ts, GET /api/editor/content/placeables).
 */

import { requestJson } from "./api.js";
import type { Placeables } from "./scene-play.js";

export type { Placeables };

export async function fetchPlaceables(base = ""): Promise<Placeables> {
  const body = await requestJson<Partial<Placeables>>(`${base}/api/editor/content/placeables`, { fail: "content list failed" });
  return { species: body.species ?? [], props: body.props ?? [], pcg: body.pcg ?? [] };
}
