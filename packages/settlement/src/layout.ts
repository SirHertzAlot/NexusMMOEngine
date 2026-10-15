/**
 * The town's layout (spec §16 to §17): a street grid, blocks split between
 * the district kinds, and a parcel on every block plot.
 *
 *   - Streets run between blocks as a sparse, connected graph (a node at every
 *     crossing, an edge per street segment); the two streets through the
 *     middle are the primary roads. This is the slice's road model, a grid.
 *     Terrain-aware, engineered alignments (spec §28) replace it later behind
 *     the same `roads` shape.
 *   - Blocks are dealt out by distance from the centre: shopping first, then
 *     housing, and the outer ring splits between agriculture and
 *     manufacturing by side (which side the "districts" stream picks).
 *   - Geometry is integer millimetres throughout.
 */

import { apportion } from "./apportion.js";
import { entityId } from "./ids.js";
import type { Streams } from "./rng.js";
import { DISTRICT_KINDS, type DistrictKind, type SettlementRules } from "./rules.js";

export interface RoadNode {
  id: string;
  x: number;
  z: number;
}

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  roadClass: "primary_town_road" | "secondary_street";
  lengthMm: number;
  widthMm: number;
}

export interface District {
  id: string;
  kind: DistrictKind;
  /** Blocks it covers. */
  blocks: number;
  areaM2: number;
}

export interface Parcel {
  id: string;
  district: string;
  kind: DistrictKind;
  /** Position on the town-wide parcel grid (neighbours differ by one). */
  gx: number;
  gz: number;
  center: { x: number; z: number };
  areaM2: number;
  roadFrontage: boolean;
}

export interface Layout {
  /** Blocks along each side of the (square) block grid. */
  blocks: number;
  roads: { nodes: RoadNode[]; edges: RoadEdge[] };
  districts: District[];
  /** In district then grid order: a parcel's index is its slot in the structure solve. */
  parcels: Parcel[];
}

/** The middle of the road network's bounding box, mm: the town's centre, which a scene puts on its origin. */
export function townCentreMm(nodes: readonly { x: number; z: number }[]): { x: number; z: number } {
  return { x: (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x))) / 2, z: (Math.min(...nodes.map((n) => n.z)) + Math.max(...nodes.map((n) => n.z))) / 2 };
}

/** The narrowest a street may be, mm: a 0.7 m character capsule always passes, however small the buildings are scaled. */
export const MIN_STREET_MM = 2000;

/**
 * Parcel and street sizes at a building `scale` (a ScaleDoc's `building` factor).
 * The rules are authored for scale 1; parcels follow the factor, streets too but
 * never narrower than MIN_STREET_MM. Integer millimetres.
 */
export function scaledLayout(rules: SettlementRules, scale = 1): { parcelMm: [number, number]; streetMm: number } {
  const { parcelSizeMm, streetWidthMm } = rules.layout;
  return { parcelMm: [Math.round(parcelSizeMm[0] * scale), Math.round(parcelSizeMm[1] * scale)], streetMm: Math.max(MIN_STREET_MM, Math.round(streetWidthMm * scale)) };
}

/** The block grid of a town of `households`: blocks per side and the pitch (block plus street) each way, mm. */
function blockGrid(households: number, rules: SettlementRules, scale: number, extraBlocks = 0): { n: number; pitchX: number; pitchZ: number; streetWidthMm: number; pw: number; pd: number } {
  const { block, parcelsPerHouseholdPermille } = rules.layout;
  const [bw, bd] = block;
  const { parcelMm, streetMm: streetWidthMm } = scaledLayout(rules, scale);
  const [pw, pd] = parcelMm;
  const parcelsWanted = Math.ceil((households * parcelsPerHouseholdPermille) / 1000);
  const n = Math.max(2, Math.ceil(Math.sqrt(Math.ceil(parcelsWanted / (bw * bd))))) + extraBlocks;
  return { n, pitchX: bw * pw + streetWidthMm, pitchZ: bd * pd + streetWidthMm, streetWidthMm, pw, pd };
}

/** Half the town's footprint, metres (the larger side, so a square window of this reach holds the whole town). Site selection measures relief over it. */
export function townHalfExtentM(households: number, rules: SettlementRules, scale = 1): number {
  const { n, pitchX, pitchZ } = blockGrid(households, rules, scale);
  return Math.ceil((n * Math.max(pitchX, pitchZ)) / 2000);
}

export function layOut(settlement: string, households: number, rules: SettlementRules, rng: Streams, scale = 1, extraBlocks = 0): Layout {
  const { block } = rules.layout;
  const [bw, bd] = block;
  const { n, pitchX, pitchZ, streetWidthMm, pw, pd } = blockGrid(households, rules, scale, extraBlocks);

  // Streets: a node at each crossing, an edge per segment.
  const nodeId = (i: number, j: number): string => entityId("junction", settlement, i, j);
  const nodes: RoadNode[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) nodes.push({ id: nodeId(i, j), x: i * pitchX - streetWidthMm / 2, z: j * pitchZ - streetWidthMm / 2 });
  const mid = Math.floor((n + 1) / 2);
  const edges: RoadEdge[] = [];
  const edge = (from: string, to: string, lengthMm: number, primary: boolean): void => {
    edges.push({ id: entityId("road", settlement, edges.length), from, to, roadClass: primary ? "primary_town_road" : "secondary_street", lengthMm, widthMm: streetWidthMm });
  };
  for (let j = 0; j <= n; j++) for (let i = 0; i < n; i++) edge(nodeId(i, j), nodeId(i + 1, j), pitchX, j === mid);
  for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) edge(nodeId(i, j), nodeId(i, j + 1), pitchZ, i === mid);

  // Blocks by distance from the centre (in half-block units, so it stays integer), then position.
  const order: { bx: number; bz: number }[] = [];
  for (let bz = 0; bz < n; bz++) for (let bx = 0; bx < n; bx++) order.push({ bx, bz });
  const dist = (b: { bx: number; bz: number }): number => (2 * b.bx - (n - 1)) ** 2 + (2 * b.bz - (n - 1)) ** 2;
  order.sort((a, b) => dist(a) - dist(b) || a.bz - b.bz || a.bx - b.bx);
  const want = apportion(n * n, rules.districtShares);
  const kindOf = new Map<string, DistrictKind>();
  const key = (b: { bx: number; bz: number }): string => `${b.bx},${b.bz}`;
  let at = 0;
  for (const kind of ["shopping", "housing"] as const) for (let k = 0; k < want[kind]!; k++) kindOf.set(key(order[at++]!), kind);
  // The outer ring splits by side: agriculture takes the blocks on one side, manufacturing the rest.
  const west = rng.get("districts").raw() < 0.5;
  const outer = order.slice(at).sort((a, b) => (west ? a.bx - b.bx : b.bx - a.bx) || a.bz - b.bz || a.bx - b.bx);
  outer.forEach((b, k) => kindOf.set(key(b), k < want.agriculture! ? "agriculture" : "manufacturing"));

  const districts: District[] = DISTRICT_KINDS.map((kind, i) => {
    const blocks = want[kind]!;
    return { id: entityId("district", settlement, i), kind, blocks, areaM2: (blocks * bw * bd * pw * pd) / 1_000_000 };
  });

  const parcels: Parcel[] = [];
  districts.forEach((d, di) => {
    let index = 0;
    for (let gz = 0; gz < n * bd; gz++) {
      for (let gx = 0; gx < n * bw; gx++) {
        const bx = Math.floor(gx / bw);
        const bz = Math.floor(gz / bd);
        if (kindOf.get(key({ bx, bz })) !== d.kind) continue;
        parcels.push({
          id: entityId("parcel", settlement, di, index++),
          district: d.id,
          kind: d.kind,
          gx,
          gz,
          center: { x: bx * pitchX + (gx % bw) * pw + pw / 2, z: bz * pitchZ + (gz % bd) * pd + pd / 2 },
          areaM2: (pw * pd) / 1_000_000,
          roadFrontage: true,
        });
      }
    }
  });
  return { blocks: n, roads: { nodes, edges }, districts, parcels };
}
