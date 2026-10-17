/**
 * A baked settlement as a scene (roadmap SG3): one group at the chosen origin
 * with a Structure node per structure, so the server's scene spawner puts the
 * town in the world (`MMO_SCENE=settlement-<id>`). The nodes carry only a kind
 * and a footprint, turned to face its street; which model stands for a kind is
 * the art side's mapping. The town wall's pieces (wall, towers, gates) are
 * Structure nodes too. Roads are not spawned yet.
 */

import { validateScene, type SceneDoc, type SceneNode } from "@mmo-engine/scene";
import type { SettlementManifest } from "./generate.js";
import { scaledLayout, townCentreMm } from "./layout.js";
import { buildingHeightM, type SettlementRules } from "./rules.js";

/** A stable index from an id (FNV-1a), so the same structure always gets the same model. */
function pick(id: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

/** Space left between a building and its parcel's edge, each side, metres. */
const MARGIN_M = 1;

export interface SceneOptions {
  /** Where the town's centre goes, in world metres [x, z]. */
  origin: [number, number];
  /** Art model ids per structure kind (`buildArtMap`); a structure takes one by its id, a kind with none stays a box. */
  art?: Record<string, string[]>;
}

export function settlementScene(manifest: SettlementManifest, rules: SettlementRules, opts: SceneOptions): SceneDoc {
  // The scene stays authored at scale 1 (the spawner applies the building factor), so a footprint is sized
  // such that, once scaled, it still leaves MARGIN_M to the scaled parcel's edge.
  const f = manifest.scale ?? 1;
  const [pw, pd] = scaledLayout(rules, f).parcelMm;
  const nodes = manifest.roads.nodes;
  const { x: cx, z: cz } = townCentreMm(nodes);
  const parcels = new Map(manifest.parcels.map((p) => [p.id, p]));
  const asset = (id: string, kind: string): string => {
    const models = opts.art?.[kind];
    return models ? models[pick(id, models.length)]! : "";
  };
  const children: SceneNode[] = manifest.structures.map((s) => {
    const p = parcels.get(s.parcel)!;
    // The building turns to face its street; its width runs along the street (the parcel's frontage).
    return {
      id: s.id,
      name: s.archetype,
      transform: { position: [(p.center.x - cx) / 1000, 0, (p.center.z - cz) / 1000], rotation: [0, p.facing, 0] },
      components: { Structure: { kind: s.archetype, asset: asset(s.id, s.archetype), width: (pw / 1000 - 2 * MARGIN_M) / f, depth: (pd / 1000 - 2 * MARGIN_M) / f, height: buildingHeightM(rules.archetypes[s.archetype]!, rules.architecture) } },
    };
  });
  // The wall: each piece a Structure along the ring. A gate is the opening the road passes through, so it is
  // walk-through (Collider none); the towers either side of it hold the line.
  const heights = { town_wall: rules.fortification.heightM, wall_tower: rules.fortification.towerHeightM, town_gate: rules.fortification.gateHeightM };
  for (const w of manifest.fortifications ?? []) {
    children.push({
      id: w.id,
      name: w.kind,
      transform: { position: [(w.center.x - cx) / 1000, 0, (w.center.z - cz) / 1000], rotation: [0, w.yawDeg, 0] },
      components: {
        Structure: { kind: w.kind, asset: asset(w.id, w.kind), width: w.lengthMm / 1000 / f, depth: w.thicknessMm / 1000 / f, height: heights[w.kind] },
        ...(w.kind === "town_gate" ? { Collider: { shape: "none" } } : {}),
      },
    });
  }
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
