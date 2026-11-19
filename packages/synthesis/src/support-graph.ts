/**
 * Structural support for synthesized buildings (DE3). The algorithm lives in `@mmo-engine/placement` (the server uses
 * it too, without this package's model tooling); this is the adapter from `SynthesizedPlacement`s.
 */

import { buildSupportGraph as build, type SupportGraph, type SupportOptions, type SupportPart } from "@mmo-engine/placement";
import type { SynthesizedPlacement } from "./types.js";
import { yawDegrees } from "./to-scene.js";

export { collapseFrom, ATTACHED_PARTS } from "@mmo-engine/placement";
export type { Fallen, SupportGraph, SupportLink, SupportOptions, SupportPart } from "@mmo-engine/placement";

/** A placement as a support part: its centre, size, yaw and category. */
export const supportPartOf = (p: SynthesizedPlacement): SupportPart => ({ pos: p.transform.pos, size: p.size, yawDeg: yawDegrees(p.transform.rot), category: p.category, id: p.partId });

export function buildSupportGraph(parts: readonly SynthesizedPlacement[], o: SupportOptions = {}): SupportGraph {
  return build(parts.map(supportPartOf), o);
}
