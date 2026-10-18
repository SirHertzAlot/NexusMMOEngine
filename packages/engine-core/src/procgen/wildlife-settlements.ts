/**
 * Settlement centres and sizes for the wildlife planner and for raiders, read from a scene's
 * `Structure` nodes (a settlement scene is one town: settlementScene in @mmo-engine/settlement).
 * The centre is the mean of the structures' world positions, the size their count, the radius
 * the farthest one from the centre. A scene with no structures is no settlement. The town wall's
 * pieces, the town square with its well, the farms' fields, the paving and the street props (WALL_KINDS) are not buildings: they count toward neither the size nor the radius.
 */

import { expandPrefabs, worldNodes, type PrefabLookup, type SceneDoc } from "@mmo-engine/scene";
import type { RaidSettlement } from "../creatures.js";

/** The Structure kinds that are not buildings: the town wall (settlement layout's WallPieceKind), the square, fields, paving and props (settlement's PROP_KINDS, terraces and stairs) and what players gather (its resource node kinds). */
const WALL_KINDS = new Set(["town_wall", "wall_tower", "town_gate", "town_square", "town_well", "farm_field", "paved_road", "terrace", "stair_step", "street_lamp", "bench", "fountain", "statue", "barrel", "crate", "planter", "log_pile", "ore_cart", "fish_rack", "grain_sacks", "guild_banner", "tree_stand", "ore_vein", "fishing_spot"]);

export function sceneSettlements(scene: SceneDoc, prefabs?: PrefabLookup): RaidSettlement[] {
  const doc = prefabs ? expandPrefabs(scene, prefabs).doc : scene;
  const pts: Array<[number, number]> = [];
  for (const w of worldNodes(doc)) {
    const kind = w.node.components?.Structure?.kind;
    if (kind !== undefined && !WALL_KINDS.has(String(kind))) pts.push([w.position[0], w.position[2]]);
  }
  if (pts.length === 0) return [];
  let x = 0;
  let z = 0;
  for (const [px, pz] of pts) { x += px; z += pz; }
  x /= pts.length;
  z /= pts.length;
  let radius = 0;
  for (const [px, pz] of pts) radius = Math.max(radius, Math.hypot(px - x, pz - z));
  return [{ x, z, size: pts.length, radius }];
}
