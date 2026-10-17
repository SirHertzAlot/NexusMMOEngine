/**
 * The town's layout (spec §16 to §17): a walled street grid in quarters,
 * farms outside along the roads out of the gates, and a parcel on every plot.
 *
 *   - Streets run between blocks as a sparse, connected graph (a node at every
 *     crossing, an edge per street segment); the two streets through the
 *     middle are the primary roads, and they leave the town through its gates
 *     as country roads. Terrain-aware, engineered alignments (spec §28) replace
 *     the grid later behind the same `roads` shape.
 *   - Inside, each district is one quarter: the market quarter at the centre
 *     (nearest the crossing of the primary roads), the craft quarter (manufacturing)
 *     along one side of the town around its gate, and housing in the rest.
 *   - Agriculture is outside: as many farm plots as feed the town (with
 *     `farmSurplusPermille` to spare) line both sides of each country road,
 *     dealt round the four roads so every gate has its fields. The agriculture
 *     share only takes its blocks out of the walled grid.
 *   - A town of `fortification.minHouseholds` or more is walled: a ring
 *     between the streets and the farms, made of wall pieces, a tower at each
 *     corner and every `towerSpacingMm`, and a gate (an opening flanked by two
 *     towers) where each primary road crosses it. Smaller places are open villages.
 *   - Every plot faces its street (`facing`, a yaw in degrees), so the buildings
 *     of a block stand in rows with their fronts on the road.
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
  roadClass: "primary_town_road" | "secondary_street" | "country_road";
  lengthMm: number;
  widthMm: number;
}

export interface District {
  id: string;
  kind: DistrictKind;
  /** Blocks it covers (agriculture: its plots, counted in blocks' worth). */
  blocks: number;
  areaM2: number;
}

/** Which way a building's front faces, degrees about +Y: 0 is +z, 90 is +x, 180 is -z, 270 is -x. */
export type Facing = 0 | 90 | 180 | 270;

export interface Parcel {
  id: string;
  district: string;
  kind: DistrictKind;
  /** Position on the town-wide parcel grid (neighbours differ by one; each farm lane is its own row). */
  gx: number;
  gz: number;
  center: { x: number; z: number };
  areaM2: number;
  roadFrontage: boolean;
  /** The street it fronts on: the building turns to face it. Its width runs along the street, its depth away from it. */
  facing: Facing;
}

export type WallPieceKind = "town_wall" | "wall_tower" | "town_gate";

/** One piece of the town wall: a run of wall, a tower or a gate. Length runs along the wall (x at yaw 0, z at yaw 90). */
export interface WallPiece {
  id: string;
  kind: WallPieceKind;
  center: { x: number; z: number };
  lengthMm: number;
  thicknessMm: number;
  yawDeg: 0 | 90;
}

export interface Layout {
  /** Blocks along each side of the (square) walled block grid. */
  blocks: number;
  /** Whether the town has a wall (`fortification.minHouseholds`). */
  walled: boolean;
  /** Wall pieces left out because water stands there (a town on a shore is open to the water on that side). */
  wallOpenToWater: number;
  roads: { nodes: RoadNode[]; edges: RoadEdge[] };
  districts: District[];
  /** In district then grid order: a parcel's index is its slot in the structure solve. */
  parcels: Parcel[];
  /** The town wall, empty for an open village. */
  fortifications: WallPiece[];
}

/** The middle of the road network's bounding box, mm: the town's centre, which a scene puts on its origin. */
export function townCentreMm(nodes: readonly { x: number; z: number }[]): { x: number; z: number } {
  return { x: (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x))) / 2, z: (Math.min(...nodes.map((n) => n.z)) + Math.max(...nodes.map((n) => n.z))) / 2 };
}

/** The narrowest a street may be, mm: a 0.7 m character capsule always passes, however small the buildings are scaled. */
export const MIN_STREET_MM = 2000;
/** A gate's opening beyond the road's width, mm (a metre each side). */
const GATE_CLEARANCE_MM = 2000;

/**
 * Parcel and street sizes at a building `scale` (a ScaleDoc's `building` factor).
 * The rules are authored for scale 1; parcels follow the factor, streets too but
 * never narrower than MIN_STREET_MM. Integer millimetres.
 */
export function scaledLayout(rules: SettlementRules, scale = 1): { parcelMm: [number, number]; streetMm: number } {
  const { parcelSizeMm, streetWidthMm } = rules.layout;
  return { parcelMm: [Math.round(parcelSizeMm[0] * scale), Math.round(parcelSizeMm[1] * scale)], streetMm: Math.max(MIN_STREET_MM, Math.round(streetWidthMm * scale)) };
}

/** The wall's sizes at a building `scale`, mm (lengths follow the factor like parcels; the gate opening is the road plus a metre each side). */
export function scaledFortification(rules: SettlementRules, scale = 1): { setbackMm: number; thicknessMm: number; pieceMm: number; towerMm: number; towerSpacingMm: number; gateMm: number } {
  const f = rules.fortification;
  const s = (mm: number): number => Math.round(mm * scale);
  return { setbackMm: s(f.setbackMm), thicknessMm: s(f.thicknessMm), pieceMm: s(f.pieceMm), towerMm: s(f.towerMm), towerSpacingMm: s(f.towerSpacingMm), gateMm: scaledLayout(rules, scale).streetMm + GATE_CLEARANCE_MM };
}

/**
 * What a wall piece of each kind must fit, metres at scale 1 (length along the wall, thickness, height): the
 * art side sizes its models to these the way it sizes a building to its parcel.
 */
export function fortificationSizesM(rules: SettlementRules): Record<WallPieceKind, { lengthM: number; thicknessM: number; heightM: number }> {
  const w = scaledFortification(rules, 1);
  const f = rules.fortification;
  return {
    town_wall: { lengthM: w.pieceMm / 1000, thicknessM: w.thicknessMm / 1000, heightM: f.heightM },
    wall_tower: { lengthM: w.towerMm / 1000, thicknessM: w.towerMm / 1000, heightM: f.towerHeightM },
    town_gate: { lengthM: w.gateMm / 1000, thicknessM: w.thicknessMm / 1000, heightM: f.gateHeightM },
  };
}

interface Plan {
  /** Inner (walled) blocks per side. */
  m: number;
  pitchX: number;
  pitchZ: number;
  streetWidthMm: number;
  pw: number;
  pd: number;
  /** Blocks per district kind inside; agriculture's is its farm plots in blocks' worth (rounded up). */
  want: Record<DistrictKind, number>;
  /** Farm plots outside the town. */
  farms: number;
  walled: boolean;
}

/**
 * How big the town is: the blocks it needs for its households, split between the districts by the shares, and
 * the square grid the non-farm blocks fill inside (any spare block is housing).
 */
function plan(households: number, rules: SettlementRules, scale: number, extraBlocks = 0): Plan {
  const { block, parcelsPerHouseholdPermille } = rules.layout;
  const [bw, bd] = block;
  const { parcelMm, streetMm: streetWidthMm } = scaledLayout(rules, scale);
  const [pw, pd] = parcelMm;
  const parcelsWanted = Math.ceil((households * parcelsPerHouseholdPermille) / 1000);
  const n = Math.max(2, Math.ceil(Math.sqrt(Math.ceil(parcelsWanted / (bw * bd))))) + extraBlocks;
  const shares = apportion(n * n, rules.districtShares) as Record<DistrictKind, number>;
  const inner = n * n - shares.agriculture;
  const m = Math.max(1, Math.ceil(Math.sqrt(inner)));
  // Farms are not blocks: as many plots as it takes to feed the town (with the surplus), by the best-feeding
  // archetype that farms; with none, the agriculture share's plots.
  const feeds = Math.max(0, ...Object.values(rules.archetypes).filter((a) => a.kinds.includes("agriculture")).map((a) => a.feeds));
  const people = Math.ceil((households * rules.demographics.householdSizeX10) / 10);
  // A town grown to make up for wet ground (`extraBlocks`) also gets a farm more on each of its eight lanes per row.
  const farms = (feeds > 0 ? Math.max(1, Math.ceil((people * rules.layout.farmSurplusPermille) / (1000 * feeds))) : shares.agriculture * bw * bd) + 8 * extraBlocks;
  const want = { ...shares, housing: shares.housing + (m * m - inner), agriculture: Math.ceil(farms / (bw * bd)) };
  return { m, pitchX: bw * pw + streetWidthMm, pitchZ: bd * pd + streetWidthMm, streetWidthMm, pw, pd, want, farms, walled: households >= rules.fortification.minHouseholds };
}

/** Half the walled town's footprint, metres (the larger side, streets and wall, not the farms outside). Site selection measures relief over it. */
export function townHalfExtentM(households: number, rules: SettlementRules, scale = 1): number {
  const { m, pitchX, pitchZ, streetWidthMm, walled } = plan(households, rules, scale);
  const w = scaledFortification(rules, scale);
  const ring = walled ? 2 * (w.setbackMm + w.thicknessMm) : 0;
  return Math.ceil((m * Math.max(pitchX, pitchZ) + streetWidthMm + ring) / 2000);
}

/** `total` mm as `parts` whole lengths that add up to it exactly. */
function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total - base * parts ? 1 : 0));
}

export function layOut(settlement: string, households: number, rules: SettlementRules, rng: Streams, scale = 1, extraBlocks = 0): Layout {
  const [bw, bd] = rules.layout.block;
  const { m, pitchX, pitchZ, streetWidthMm: s, pw, pd, want, farms, walled } = plan(households, rules, scale, extraBlocks);
  const wall = scaledFortification(rules, scale);

  // Streets: a node at each crossing, an edge per segment.
  const nodeId = (i: number, j: number): string => entityId("junction", settlement, i, j);
  const nodes: RoadNode[] = [];
  for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) nodes.push({ id: nodeId(i, j), x: i * pitchX - s / 2, z: j * pitchZ - s / 2 });
  const mid = Math.floor((m + 1) / 2);
  const edges: RoadEdge[] = [];
  const edge = (from: string, to: string, lengthMm: number, roadClass: RoadEdge["roadClass"]): void => {
    edges.push({ id: entityId("road", settlement, edges.length), from, to, roadClass, lengthMm, widthMm: s });
  };
  for (let j = 0; j <= m; j++) for (let i = 0; i < m; i++) edge(nodeId(i, j), nodeId(i + 1, j), pitchX, j === mid ? "primary_town_road" : "secondary_street");
  for (let i = 0; i <= m; i++) for (let j = 0; j < m; j++) edge(nodeId(i, j), nodeId(i, j + 1), pitchZ, i === mid ? "primary_town_road" : "secondary_street");

  // Quarters. The market quarter is the blocks nearest the centre (distance in half-block units, so it stays
  // integer); the craft quarter is the blocks along one side (the "districts" stream picks which), nearest the
  // primary road first so it gathers around that side's gate; housing is the rest.
  const blocks: { bx: number; bz: number }[] = [];
  for (let bz = 0; bz < m; bz++) for (let bx = 0; bx < m; bx++) blocks.push({ bx, bz });
  const dist = (b: { bx: number; bz: number }): number => (2 * b.bx - (m - 1)) ** 2 + (2 * b.bz - (m - 1)) ** 2;
  const key = (b: { bx: number; bz: number }): string => `${b.bx},${b.bz}`;
  const kindOf = new Map<string, DistrictKind>();
  const central = [...blocks].sort((a, b) => dist(a) - dist(b) || a.bz - b.bz || a.bx - b.bx);
  for (const b of central.slice(0, want.shopping)) kindOf.set(key(b), "shopping");
  const side = Math.floor(rng.get("districts").raw() * 4);
  // Distance from the chosen side, and from the primary road running out through that side's gate.
  const fromSide = (b: { bx: number; bz: number }): number => [b.bx, m - 1 - b.bx, b.bz, m - 1 - b.bz][side]!;
  const fromRoad = (b: { bx: number; bz: number }): number => (side < 2 ? Math.abs(2 * b.bz + 1 - 2 * mid) : Math.abs(2 * b.bx + 1 - 2 * mid));
  const rest = blocks.filter((b) => !kindOf.has(key(b))).sort((a, b) => fromSide(a) - fromSide(b) || fromRoad(a) - fromRoad(b) || a.bz - b.bz || a.bx - b.bx);
  rest.forEach((b, k) => kindOf.set(key(b), k < want.manufacturing ? "manufacturing" : "housing"));

  const districts: District[] = DISTRICT_KINDS.map((kind, i) => {
    const blocks = want[kind];
    const plots = kind === "agriculture" ? farms : blocks * bw * bd;
    return { id: entityId("district", settlement, i), kind, blocks, areaM2: (plots * pw * pd) / 1_000_000 };
  });

  // The town's edge: the outer side of its outermost streets. The wall's centre line (if any) is a setback and
  // half a thickness beyond it; country roads start at the outermost junctions and run out through the gates.
  const lo = { x: -s, z: -s };
  const hi = { x: m * pitchX, z: m * pitchZ };
  const out = walled ? wall.setbackMm + wall.thicknessMm / 2 : 0;
  // Farms start a setback beyond the wall's outer face (or the street, for a village).
  const farmStart = s / 2 + (walled ? 2 * wall.setbackMm + wall.thicknessMm : wall.setbackMm);
  const perLane = Math.ceil(farms / 8);
  const roadOut = farmStart + Math.max(1, perLane) * pw;
  const xr = mid * pitchX - s / 2;
  const zr = mid * pitchZ - s / 2;
  // The four ways out: west, east, north, south (dx, dz), each from its outermost junction on the primary road.
  const exits = [
    { from: nodeId(0, mid), at: { x: -s / 2, z: zr }, dx: -1, dz: 0 },
    { from: nodeId(m, mid), at: { x: m * pitchX - s / 2, z: zr }, dx: 1, dz: 0 },
    { from: nodeId(mid, 0), at: { x: xr, z: -s / 2 }, dx: 0, dz: -1 },
    { from: nodeId(mid, m), at: { x: xr, z: m * pitchZ - s / 2 }, dx: 0, dz: 1 },
  ];
  exits.forEach((e, k) => {
    let from = e.from;
    if (walled) {
      // The gate: where the road crosses the wall's centre line.
      const reach = s / 2 + out;
      const gate = { id: entityId("gatehouse", settlement, k), x: e.at.x + e.dx * reach, z: e.at.z + e.dz * reach };
      nodes.push(gate);
      edge(from, gate.id, reach, "country_road");
      from = gate.id;
    }
    const end = { id: entityId("roadend", settlement, k), x: e.at.x + e.dx * roadOut, z: e.at.z + e.dz * roadOut };
    nodes.push(end);
    edge(from, end.id, roadOut - (walled ? s / 2 + out : 0), "country_road");
  });

  const parcels: Parcel[] = [];
  districts.forEach((d, di) => {
    let index = 0;
    if (d.kind === "agriculture") {
      // Farm lanes: each side of each country road, dealt round so the fields spread over all four.
      // Lane order: west-north, east-south, north-east, south-west, then the other sides.
      const lanes = [
        [0, -1], [1, 1], [2, 1], [3, -1],
        [0, 1], [1, -1], [2, -1], [3, 1],
      ] as const;
      for (let f = 0; f < farms; f++) {
        const [ei, sideSign] = lanes[f % 8]!;
        const k = Math.floor(f / 8);
        const e = exits[ei]!;
        const along = farmStart + k * pw + pw / 2;
        // Across the road: half the road and half the plot's depth, on this lane's side.
        const across = sideSign * (s / 2 + pd / 2);
        const center = e.dx !== 0 ? { x: e.at.x + e.dx * along, z: e.at.z + across } : { x: e.at.x + across, z: e.at.z + e.dz * along };
        // It faces back across to the road.
        const facing: Facing = e.dx !== 0 ? (sideSign < 0 ? 0 : 180) : sideSign < 0 ? 90 : 270;
        parcels.push({ id: entityId("parcel", settlement, di, index++), district: d.id, kind: d.kind, gx: k, gz: -1000 * (1 + (f % 8)), center, areaM2: (pw * pd) / 1_000_000, roadFrontage: true, facing });
      }
      return;
    }
    for (let gz = 0; gz < m * bd; gz++) {
      for (let gx = 0; gx < m * bw; gx++) {
        const bx = Math.floor(gx / bw);
        const bz = Math.floor(gz / bd);
        if (kindOf.get(key({ bx, bz })) !== d.kind) continue;
        // The block's front rows face the street before them (-z), its back rows the street behind (+z).
        const facing: Facing = gz % bd < bd / 2 ? 180 : 0;
        parcels.push({
          id: entityId("parcel", settlement, di, index++),
          district: d.id,
          kind: d.kind,
          gx,
          gz,
          center: { x: bx * pitchX + (gx % bw) * pw + pw / 2, z: bz * pitchZ + (gz % bd) * pd + pd / 2 },
          areaM2: (pw * pd) / 1_000_000,
          roadFrontage: true,
          facing,
        });
      }
    }
  });
  return { blocks: m, walled, wallOpenToWater: 0, roads: { nodes, edges }, districts, parcels, fortifications: walled ? fortify(settlement, lo, hi, out, { x: xr, z: zr }, wall) : [] };
}

/**
 * The wall ring around the box `lo`..`hi` (the streets' outer edge), its centre line `out` beyond it: a tower at
 * each corner (on the north and south runs), a gate with a tower each side where the primary roads (`road`) cross,
 * and between them wall pieces no longer than `pieceMm`, with a tower wherever a stretch would pass `towerSpacingMm`.
 */
function fortify(settlement: string, lo: { x: number; z: number }, hi: { x: number; z: number }, out: number, road: { x: number; z: number }, w: ReturnType<typeof scaledFortification>): WallPiece[] {
  const pieces: WallPiece[] = [];
  const t = w.towerMm;
  const add = (kind: WallPieceKind, a: number, lengthMm: number, fixed: number, alongX: boolean): void => {
    pieces.push({ id: entityId("wall", settlement, pieces.length), kind, center: alongX ? { x: a, z: fixed } : { x: fixed, z: a }, lengthMm, thicknessMm: kind === "wall_tower" ? t : w.thicknessMm, yawDeg: alongX ? 0 : 90 });
  };
  // A run of wall from `a0` to `a1` along one side: towers where it is too long between towers, wall pieces between.
  const run = (a0: number, a1: number, fixed: number, alongX: boolean): void => {
    const span = a1 - a0;
    if (span <= 0) return;
    const stretches = Math.max(1, Math.ceil(span / (w.towerSpacingMm + t)));
    const lengths = split(span - (stretches - 1) * t, stretches);
    let a = a0;
    lengths.forEach((len, i) => {
      for (const piece of split(len, Math.max(1, Math.ceil(len / w.pieceMm)))) {
        add("town_wall", a + piece / 2, piece, fixed, alongX);
        a += piece;
      }
      if (i < lengths.length - 1) {
        add("wall_tower", a + t / 2, t, fixed, alongX);
        a += t;
      }
    });
  };
  // A side from `a0` to `a1` with the gate at `g`: posts (towers, the gate) and the runs between them.
  const side = (a0: number, a1: number, g: number, fixed: number, alongX: boolean, corners: boolean): void => {
    const posts: { kind: WallPieceKind; a: number; len: number }[] = [];
    if (corners) posts.push({ kind: "wall_tower", a: a0 + t / 2, len: t });
    posts.push({ kind: "wall_tower", a: g - w.gateMm / 2 - t / 2, len: t }, { kind: "town_gate", a: g, len: w.gateMm }, { kind: "wall_tower", a: g + w.gateMm / 2 + t / 2, len: t });
    if (corners) posts.push({ kind: "wall_tower", a: a1 - t / 2, len: t });
    let at = a0;
    for (const p of posts) {
      run(at, p.a - p.len / 2, fixed, alongX);
      add(p.kind, p.a, p.len, fixed, alongX);
      at = p.a + p.len / 2;
    }
    run(at, a1, fixed, alongX);
  };
  const x0 = lo.x - out;
  const x1 = hi.x + out;
  const z0 = lo.z - out;
  const z1 = hi.z + out;
  // North and south run corner to corner (outer tower faces); west and east fit between the corner towers.
  side(x0 - t / 2, x1 + t / 2, road.x, z0, true, true);
  side(x0 - t / 2, x1 + t / 2, road.x, z1, true, true);
  side(z0 + t / 2, z1 - t / 2, road.z, x0, false, false);
  side(z0 + t / 2, z1 - t / 2, road.z, x1, false, false);
  return pieces;
}
