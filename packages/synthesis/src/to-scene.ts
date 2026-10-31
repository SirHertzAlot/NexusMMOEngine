import type { SceneDoc, SceneKind, SceneNode } from "@mmo-engine/scene";
import type { QuatTuple, SynthesisOutput } from "./types.js";

export interface SceneExportOptions {
  /** The scene's name: content/scenes/<name>.scene.json. */
  name: string;
  /** The scene kind the server spawns it as (default "arena"). */
  kind?: SceneKind;
  /** Art catalog model per placed asset ref; a part without one is a stand-in box. */
  assets?: Record<string, string>;
}

/** The yaw of a quaternion (x, y, z, w) about the vertical axis, in degrees. */
export function yawDegrees([x, y, z, w]: QuatTuple): number {
  return (Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
}

/** Round to millimetres, the precision a scene file keeps. */
const mm = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * A synthesized room as a scene document. Each placed part becomes a Structure
 * node, so the server spawns the room the way it spawns any scene (MMO_SCENE).
 * A part keeps its yaw (the scene's rotation about Y, in degrees) and its size
 * in metres. Tilt is dropped: a scene node turns about the vertical axis only.
 * Takes any output with placements, so a grammar's placements export the same way.
 */
export function synthesisToScene(out: Pick<SynthesisOutput, "placements">, o: SceneExportOptions): SceneDoc {
  const nodes: SceneNode[] = out.placements.map((p, i) => {
    const [w, h, d] = p.size;
    return {
      id: `part-${i}`,
      name: p.partId,
      transform: { position: [...p.transform.pos], rotation: [0, yawDegrees(p.transform.rot), 0] },
      components: {
        Structure: {
          kind: p.category || p.partId,
          asset: o.assets?.[p.assetRef] ?? "",
          width: mm(Math.abs(w)),
          depth: mm(Math.abs(d)),
          height: mm(Math.abs(h)),
        },
      },
    };
  });
  return { version: 1, name: o.name, kind: o.kind ?? "arena", nodes };
}
