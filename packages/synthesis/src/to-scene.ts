import type { SceneDoc, SceneKind, SceneNode } from "@mmo-engine/scene";
import type { SynthesisOutput } from "./types.js";

export interface SceneExportOptions {
  /** The scene's name: content/scenes/<name>.scene.json. */
  name: string;
  /** The scene kind the server spawns it as (default "arena"). */
  kind?: SceneKind;
  /** Art catalog model per placed asset ref; a part without one is a stand-in box. */
  assets?: Record<string, string>;
}

/**
 * A synthesized room as a scene document. Each placed part becomes a Structure
 * node, so the server spawns the room the way it spawns any scene (MMO_SCENE).
 * Parts are axis-aligned boxes: a part's yaw and tilt are not carried over yet.
 */
export function synthesisToScene(out: SynthesisOutput, o: SceneExportOptions): SceneDoc {
  const nodes: SceneNode[] = out.placements.map((p, i) => {
    const [sx, sy, sz] = p.transform.scale;
    return {
      id: `part-${i}`,
      name: p.partId,
      transform: { position: [...p.transform.pos] },
      components: {
        Structure: {
          kind: p.category || p.partId,
          asset: o.assets?.[p.assetRef] ?? "",
          width: Math.abs(sx),
          depth: Math.abs(sz),
          height: Math.abs(sy),
        },
      },
    };
  });
  return { version: 1, name: o.name, kind: o.kind ?? "arena", nodes };
}
