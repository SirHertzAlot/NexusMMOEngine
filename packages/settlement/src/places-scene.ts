/**
 * The places plan as a scene (roadmap SG7, SG8): one world scene, `places`, with a Structure node per place, each
 * standing at its world position (the scene's root is the world origin), so the server's scene spawner puts them
 * in the world (`MMO_SCENE=places`). Like the town scenes the nodes carry only a kind and a footprint; the art side
 * maps a kind to a model, and a kind with none stays a box. A homestead is a farmhouse with its field (a farm) or
 * pen (a ranch) beside it, walked through; a camp site is a walk-through clearing with a fire pit. Who lives or
 * keeps watch there (the family, the outpost's guards, the innkeeper) comes later: the plan names them.
 */

import { validateScene, type SceneDoc, type SceneNode } from "@mmo-engine/scene";
import type { Place, PlaceKind, PlacesPlan } from "./places.js";

interface Look {
  kind: string;
  size: [number, number, number];
  /** Walked through, not round. */
  open?: boolean;
}

/** What each place looks like: width, depth and height in metres. */
export const PLACE_LOOKS: Record<PlaceKind, Look> = {
  guard_outpost: { kind: "guard_outpost", size: [9, 9, 10] },
  inn: { kind: "roadside_inn", size: [18, 12, 9] },
  shack: { kind: "shack", size: [4, 5, 3] },
  camp_site: { kind: "camp_site", size: [8, 8, 0.3], open: true },
  homestead: { kind: "farmhouse", size: [10, 8, 6] },
};

/** A farm's field and a ranch's pen, beside the house: width, depth, height. */
const HOLDING: Record<NonNullable<Place["works"]>, Look> = {
  farm: { kind: "farm_field", size: [60, 40, 0.1], open: true },
  ranch: { kind: "ranch_pen", size: [50, 50, 1.2] },
};
/** How far the holding's centre is from the house, metres. */
const HOLDING_OFFSET_M = 36;

/**
 * A farm's yard dressing (DEFAULT_DRESSING_PATTERNS): a tool stand and a produce pile on the house's back side, a well
 * on the field side. Each is [x, z] in metres from the house, in the house's own frame (before its yaw), just outside
 * the house's 10 by 8 m footprint, so the house stays walkable around them.
 */
const YARD: Array<{ kind: string; at: [number, number]; size: [number, number, number] }> = [
  { kind: "farm_tools", at: [-8, 3], size: [2, 1, 1.2] },
  { kind: "farm_produce", at: [-8, -3], size: [1.5, 1.5, 0.8] },
  { kind: "farm_yard", at: [8, 3], size: [2, 2, 1.5] },
];

/** A stable yaw (a multiple of 90) from an id, so the same place always faces the same way. */
function facing(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 4) * 90;
}

const node = (id: string, name: string, x: number, z: number, look: Look, yaw: number, asset = ""): SceneNode => ({
  id,
  name,
  transform: { position: [x, 0, z], rotation: [0, yaw, 0] },
  components: { Structure: { kind: look.kind, asset, width: look.size[0], depth: look.size[1], height: look.size[2] }, ...(look.open ? { Collider: { shape: "none" } } : {}) },
});

export function placesScene(plan: PlacesPlan, art?: Record<string, string[]>): SceneDoc {
  const asset = (look: Look): string => art?.[look.kind]?.[0] ?? "";
  const children: SceneNode[] = [];
  for (const p of plan.places) {
    const look = PLACE_LOOKS[p.kind];
    const yaw = facing(p.id);
    children.push(node(p.id, look.kind, p.x, p.z, look, yaw, asset(look)));
    if (p.kind === "homestead" && p.works) {
      const hold = HOLDING[p.works];
      const rad = (yaw * Math.PI) / 180;
      children.push(node(`${p.id}-${p.works}`, hold.kind, p.x + Math.round(Math.sin(rad) * HOLDING_OFFSET_M), p.z + Math.round(Math.cos(rad) * HOLDING_OFFSET_M), hold, yaw, asset(hold)));
      if (p.works === "farm") {
        for (const d of YARD) {
          const look: Look = { kind: d.kind, size: d.size, open: false };
          const [lx, lz] = d.at;
          const x = p.x + Math.round(lx * Math.cos(rad) + lz * Math.sin(rad));
          const z = p.z + Math.round(-lx * Math.sin(rad) + lz * Math.cos(rad));
          children.push(node(`${p.id}-${d.kind}`, d.kind, x, z, look, yaw, asset(look)));
        }
      }
    }
  }
  const scene: SceneDoc = { version: 1, name: "places", kind: "world", nodes: [{ id: "places", name: "Places between the towns", transform: { position: [0, 0, 0] }, children }] };
  const issues = validateScene(scene);
  if (issues.length) throw new Error(`the places are not a valid scene: ${issues.map((i) => `${i.path || "(scene)"} ${i.message}`).join("; ")}`);
  return scene;
}
