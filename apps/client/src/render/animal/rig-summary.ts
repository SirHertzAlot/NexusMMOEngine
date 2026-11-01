/**
 * What a model's procedural rig came out as, in numbers the editor's rig view
 * can show: the rig type, the size in the normalised frame, and how many
 * vertices each bone drives (a vertex belongs to the bone with the most weight).
 * Pure: it reads a Segmentation, nothing else.
 */

import { BONE_NAMES, type Segmentation } from "./segment.js";

export interface RigSummary {
  type: string;
  length: number;
  height: number;
  width: number;
  legLength: number;
  kneeHeight: number;
  /** One entry per bone, in the rig's bone order; `vertices` is how many vertices it drives most. */
  bones: Array<{ name: string; vertices: number }>;
  /** Vertices with no bone weight at all (none in a sound rig). */
  unweighted: number;
}

/** Bone index of the strongest weight per vertex; -1 when a vertex has no weight. */
export function dominantBones(seg: Segmentation, vertexCount: number): Int16Array {
  const out = new Int16Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    let best = -1;
    let bestW = 0;
    for (let k = 0; k < 4; k++) {
      const w = seg.skinWeight[v * 4 + k] ?? 0;
      if (w > bestW) {
        bestW = w;
        best = seg.skinIndex[v * 4 + k] ?? -1;
      }
    }
    out[v] = best;
  }
  return out;
}

export function summarizeRig(seg: Segmentation, vertexCount: number): RigSummary {
  const names = seg.boneNames ?? BONE_NAMES;
  const counts = new Array<number>(names.length).fill(0);
  let unweighted = 0;
  for (const b of dominantBones(seg, vertexCount)) {
    if (b < 0 || b >= names.length) unweighted++;
    else counts[b]!++;
  }
  return {
    type: seg.type ?? "quadruped",
    length: seg.length,
    height: seg.height,
    width: seg.width,
    legLength: seg.legLength,
    kneeHeight: seg.kneeHeight,
    bones: names.map((name, i) => ({ name, vertices: counts[i]! })),
    unweighted,
  };
}
