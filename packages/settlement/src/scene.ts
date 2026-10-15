/**
 * A baked settlement as a scene (roadmap SG3): one group at the chosen origin
 * with a Structure node per structure, so the server's scene spawner puts the
 * town in the world (`MMO_SCENE=settlement-<id>`). The nodes carry only a kind
 * and a footprint; which model stands for a kind is the art side's mapping.
 * Roads are not spawned yet.
 */

import { validateScene, type SceneDoc, type SceneNode } from "@mmo-engine/scene";
import type { SettlementManifest } from "./generate.js";
import type { SettlementRules } from "./rules.js";

/** Space left between a building and its parcel's edge, each side, metres. */
const MARGIN_M = 1;

export interface SceneOptions {
  /** Where the town's centre goes, in world metres [x, z]. */
  origin: [number, number];
}

export function settlementScene(manifest: SettlementManifest, rules: SettlementRules, opts: SceneOptions): SceneDoc {
  const [pw, pd] = rules.layout.parcelSizeMm;
  const nodes = manifest.roads.nodes;
  const cx = (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x))) / 2;
  const cz = (Math.min(...nodes.map((n) => n.z)) + Math.max(...nodes.map((n) => n.z))) / 2;
  const parcels = new Map(manifest.parcels.map((p) => [p.id, p]));
  const children: SceneNode[] = manifest.structures.map((s) => {
    const p = parcels.get(s.parcel)!;
    return {
      id: s.id,
      name: s.archetype,
      transform: { position: [(p.center.x - cx) / 1000, 0, (p.center.z - cz) / 1000] },
      components: { Structure: { kind: s.archetype, width: pw / 1000 - 2 * MARGIN_M, depth: pd / 1000 - 2 * MARGIN_M, height: rules.archetypes[s.archetype]!.heightM } },
    };
  });
  const scene: SceneDoc = {
    version: 1,
    name: `settlement-${manifest.settlementId}`,
    kind: "world",
    nodes: [{ id: `settlement-${manifest.settlementId}`, name: `Settlement ${manifest.settlementId}`, transform: { position: [opts.origin[0], 0, opts.origin[1]] }, children }],
  };
  const issues = validateScene(scene);
  if (issues.length) throw new Error(`settlement ${manifest.settlementId} is not a valid scene: ${issues.map((i) => `${i.path || "(scene)"} ${i.message}`).join("; ")}`);
  return scene;
}
