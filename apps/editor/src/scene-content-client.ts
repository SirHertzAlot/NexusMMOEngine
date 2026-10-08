/**
 * Browser-safe adapter for the viewport's content browser: what the host
 * lists as placeable (see scene-play.ts, GET /api/editor/content/placeables).
 */

import type { Placeables } from "./scene-play.js";

export type { Placeables };

export async function fetchPlaceables(base = ""): Promise<Placeables> {
  const res = await fetch(`${base}/api/editor/content/placeables`);
  if (!res.ok) throw new Error(`content list failed: HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Placeables>;
  return { species: body.species ?? [], props: body.props ?? [], pcg: body.pcg ?? [] };
}
