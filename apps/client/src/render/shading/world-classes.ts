/**
 * The registry of world object classes and how each is shaded. The one
 * list a test walks: every class is either cel (it goes through the shading
 * components as a kind) or it carries a named opt-out with its reason
 * (packages/art SHADING_OPT_OUTS). A class in neither place fails the test.
 *
 * Phase 0 audit: docs/CEL-SHADING-AUDIT.md section 4.
 */

import { SHADING_OPT_OUTS, type ShadingKind, type ShadingOptOutId } from "@mmo-engine/art/browser";

export type WorldShadingPath = { readonly kind: ShadingKind } | { readonly optOut: ShadingOptOutId };

export interface WorldClass {
  readonly id: string;
  readonly path: WorldShadingPath;
}

/** Every world class the client draws, and the shading path it takes. */
export const WORLD_CLASSES: readonly WorldClass[] = [
  { id: "terrain", path: { kind: "terrain" } },
  { id: "dungeon-stone", path: { kind: "structure" } },
  { id: "portal-stone", path: { kind: "structure" } },
  { id: "props", path: { kind: "model" } },
  { id: "synty-props", path: { kind: "model" } },
  { id: "creatures", path: { kind: "model" } },
  { id: "placeholders", path: { kind: "placeholder" } },
  { id: "prefabs", path: { kind: "prefab" } },
  { id: "npc-markers", path: { kind: "figure" } },
  { id: "corpse-proxy", path: { kind: "figure" } },
  { id: "first-person-arms", path: { kind: "figure" } },
  { id: "asset-fallbacks", path: { kind: "fallback" } },
  { id: "water", path: { optOut: "water" } },
  { id: "sky", path: { optOut: "sky" } },
  { id: "stars", path: { optOut: "stars" } },
  { id: "vfx-particles", path: { optOut: "vfx" } },
  { id: "swing-trail", path: { optOut: "swing-trail" } },
  { id: "portal-ring", path: { optOut: "portal-ring" } },
  { id: "labels", path: { optOut: "label" } },
];

/** The optional opt-out reason of a world class, or null when it is cel. */
export function optOutOf(c: WorldClass): string | null {
  return "optOut" in c.path ? SHADING_OPT_OUTS[c.path.optOut] : null;
}
